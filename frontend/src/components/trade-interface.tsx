import { useEffect, useMemo, useState, type DragEvent } from "react"
import { BrowserProvider, Contract, EventLog, isAddress, type Eip1193Provider } from "ethers"
import { SepoliaBanner } from "./sepolia-banner"
import { TradeForms } from "./trade-forms"
import { TradeList } from "./trade-list"
import { BundleBoard } from "./bundle-board"
import { TestShelf } from "./test-shelf"
import { AddAssetForm } from "./add-asset-form"
import {
  ESCROW_ABI,
  assetsFor,
  bundleFromLogs,
  isAllowlisted,
  loadAllowlist,
  readStoredAssets,
  saveAllowlist,
  type BundleLog,
  type ListedAsset,
} from "../lib/escrow"
import {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_ESCROW,
  SEPOLIA_TEST_ERC20,
  SEPOLIA_TEST_ERC721,
  TEST_ERC20_ABI,
  TEST_ERC20_MINT,
  TEST_ERC721_ABI,
  ensureSepolia,
  isSepoliaTestAsset,
} from "../lib/sepolia"
import { loadShelf, loadTrades, type KnownTrade, type Shelf } from "../lib/shelf"
import { boxKey, isSchrodingerBox, readBoxInsides, type BoxInside } from "../lib/box"

interface TradeView {
  initiator: string
  counterparty: string
  initiatorApproved: boolean
  counterpartyApproved: boolean
  executed: boolean
  deadline: bigint
  version: bigint
}

function defaultDeadlineInput() {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function deadlineToUnix(value: string) {
  const ms = new Date(value).getTime()
  if (Number.isNaN(ms)) return null
  return BigInt(Math.floor(ms / 1000))
}

function explain(error: unknown) {
  if (error && typeof error === "object" && "shortMessage" in error) {
    return String(error.shortMessage)
  }
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

async function readSettledBundle(escrow: Contract, tradeId: string) {
  const added = await escrow.queryFilter(escrow.filters.AssetAdded(tradeId))
  const removed = await escrow.queryFilter(escrow.filters.AssetRemoved(tradeId))
  const logs: BundleLog[] = []
  for (const entry of [...added, ...removed]) {
    if (!(entry instanceof EventLog)) continue
    logs.push({
      name: entry.eventName === "AssetRemoved" ? "AssetRemoved" : "AssetAdded",
      owner: String(entry.args.owner),
      contractAddress: String(entry.args.contractAddress),
      assetType: Number(entry.args.assetType ?? 0),
      tokenId: BigInt(entry.args.tokenId),
      amount: BigInt(entry.args.amount),
      blockNumber: entry.blockNumber,
      transactionIndex: entry.transactionIndex,
      logIndex: entry.index,
    })
  }
  return bundleFromLogs(logs)
}

async function storedBundle(escrow: Contract, id: string, view: TradeView) {
  const [left, right] = await Promise.all([
    readStoredAssets(escrow, id, view.initiator),
    readStoredAssets(escrow, id, view.counterparty),
  ])
  const lists = new Map<string, ListedAsset[]>()
  lists.set(view.initiator.toLowerCase(), mapStoredAssets(view.initiator, left))
  lists.set(view.counterparty.toLowerCase(), mapStoredAssets(view.counterparty, right))
  return lists
}

async function listingBlocks(escrow: Contract, id: string) {
  const added = await escrow.queryFilter(escrow.filters.AssetAdded(id))
  const blocks = new Map<string, number>()
  for (const entry of added) {
    if (!(entry instanceof EventLog)) continue
    if (Number(entry.args.assetType) !== 1) continue
    const key = boxKey(String(entry.args.contractAddress), BigInt(entry.args.tokenId))
    const previous = blocks.get(key) ?? 0
    if (entry.blockNumber >= previous) blocks.set(key, entry.blockNumber)
  }
  return blocks
}

function mapStoredAssets(owner: string, rows: Array<{ contractAddress: string; tokenId: bigint; amount: bigint; assetType: number; sealedContainer?: boolean; sealState?: bigint }>) {
  return rows.map((row) => ({
    owner,
    contractAddress: row.contractAddress,
    tokenId: row.tokenId,
    amount: row.amount,
    assetType: Number(row.assetType),
    sealedContainer: row.sealedContainer,
    sealState: row.sealState,
  }))
}

export function TradeInterface() {
  const [account, setAccount] = useState<string | null>(null)
  const [escrowAddress, setEscrowAddress] = useState(() => {
    const saved = localStorage.getItem("atomic-barter.escrow")
    return saved && isAddress(saved) ? saved : SEPOLIA_ESCROW
  })
  const [counterparty, setCounterparty] = useState("")
  const [deadlineInput, setDeadlineInput] = useState(defaultDeadlineInput)
  const [tradeId, setTradeId] = useState("")
  const [trade, setTrade] = useState<TradeView | null>(null)
  const [bundle, setBundle] = useState<Map<string, ListedAsset[]>>(new Map())
  const [insides, setInsides] = useState<Map<string, BoxInside>>(new Map())
  const [bundleSource, setBundleSource] = useState<"storage" | "events" | null>(null)
  const [assetKind, setAssetKind] = useState<"ERC20" | "ERC721">("ERC721")
  const [assetAddress, setAssetAddress] = useState("")
  const [tokenId, setTokenId] = useState("")
  const [amount, setAmount] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [chainId, setChainId] = useState<number | null>(null)
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [knownTrades, setKnownTrades] = useState<KnownTrade[]>([])
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [dropOver, setDropOver] = useState(false)

  useEffect(() => {
    setAllowlist(loadAllowlist())
  }, [])

  useEffect(() => {
    setAcknowledged(false)
  }, [assetAddress])

  useEffect(() => {
    if (!account || !window.ethereum || !isAddress(escrowAddress)) return
    let stop = false
    async function tick() {
      const ethereum = window.ethereum
      if (!ethereum) return
      try {
        const hex = await ethereum.request({ method: "eth_chainId" })
        const id = typeof hex === "string" ? Number.parseInt(hex, 16) : null
        if (stop) return
        setChainId(id)
        if (id !== SEPOLIA_CHAIN_ID) return
        const provider = new BrowserProvider(ethereum as Eip1193Provider)
        const [nextShelf, nextTrades] = await Promise.all([
          loadShelf(provider, account!),
          loadTrades(provider, escrowAddress, account!),
        ])
        if (stop) return
        setShelf(nextShelf)
        setKnownTrades(nextTrades)
        setCheckedAt(Date.now())
      } catch {
        // Keep the last snapshot when a public RPC refuses a log query.
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 12000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [account, escrowAddress])

  const unknownAsset = isAddress(assetAddress) && !isSepoliaTestAsset(assetAddress) && !isAllowlisted(assetAddress, allowlist)
  const canAddUnknown = !unknownAsset || acknowledged

  const myAssets = useMemo(() => {
    if (!account) return []
    return assetsFor(bundle, account)
  }, [account, bundle])

  const theirAssets = useMemo(() => {
    if (!trade || !account) return []
    const other = account.toLowerCase() === trade.initiator.toLowerCase() ? trade.counterparty : trade.initiator
    return assetsFor(bundle, other)
  }, [account, bundle, trade])

  async function walletSigner() {
    const ethereum = window.ethereum
    if (!ethereum) throw new Error("Connect a wallet first.")
    // Start the account request in this click turn. Firefox drops the popup
    // if the first wallet call is only made after another await.
    const accounts = ethereum.request({ method: "eth_requestAccounts" })
    await ensureSepolia()
    await accounts
    const provider = new BrowserProvider(ethereum as Eip1193Provider)
    return provider.getSigner()
  }

  async function connect() {
    if (!window.ethereum) {
      setStatus("This browser has no wallet. Install one and reload the page.")
      return
    }
    try {
      const signer = await walletSigner()
      setAccount(await signer.getAddress())
    } catch (error) {
      setStatus(explain(error))
    }
  }

  function escrowContract(signerOrProvider: BrowserProvider | Awaited<ReturnType<BrowserProvider["getSigner"]>>) {
    if (!isAddress(escrowAddress)) throw new Error("Paste the Atomic Barter contract address first.")
    return new Contract(escrowAddress, ESCROW_ABI, signerOrProvider)
  }

  async function signerContract() {
    return escrowContract(await walletSigner())
  }

  async function refresh(id = tradeId, quiet = false) {
    if (!isAddress(escrowAddress) || !id.startsWith("0x") || id.length !== 66) return
    if (!window.ethereum) {
      if (quiet) return
      throw new Error("Connect a wallet to read the trade.")
    }
    if (!quiet) await ensureSepolia()
    const provider = new BrowserProvider(window.ethereum as Eip1193Provider)
    const escrow = escrowContract(provider)
    const row = await escrow.getTrade(id)
    const view: TradeView = {
      initiator: row[0],
      counterparty: row[1],
      initiatorApproved: row[2],
      counterpartyApproved: row[3],
      executed: row[4],
      deadline: row[7],
      version: row[8],
    }
    setTrade(view)
    const lists = view.executed
      ? await readSettledBundle(escrow, id)
      : await storedBundle(escrow, id, view)
    setBundle(lists)
    setBundleSource(view.executed ? "events" : "storage")
    const flat = [...lists.values()].flat()
    const listedAt = await listingBlocks(escrow, id)
    setInsides(await readBoxInsides(provider, flat, listedAt))
  }

  useEffect(() => {
    if (!account || !tradeId.startsWith("0x") || tradeId.length !== 66) return
    const timer = window.setInterval(() => {
      void refresh(tradeId, true).catch(() => undefined)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [account, tradeId, escrowAddress])

  async function createTrade() {
    const deadline = deadlineToUnix(deadlineInput)
    if (!isAddress(counterparty)) {
      setStatus("The other person's address is not valid. It must start with 0x.")
      return
    }
    if (deadline === null) {
      setStatus("Choose the day and time when the trade expires.")
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      localStorage.setItem("atomic-barter.escrow", escrowAddress)
      const escrow = await signerContract()
      const tx = await escrow.createTrade(counterparty, deadline)
      const receipt = await tx.wait()
      const created = receipt.logs
        .map((entry: { topics: string[]; data: string }) => {
          try {
            return escrow.interface.parseLog(entry)
          } catch {
            return null
          }
        })
        .find((parsed: { name: string } | null) => parsed?.name === "TradeCreated")
      if (!created) throw new Error("The trade was not created. Check the transaction in your wallet.")
      const id = String(created.args.tradeId)
      setTradeId(id)
      await refresh(id)
      setStatus("Trade created. The code is in the field beside this message. Accept only the version shown below: if the list changes, the earlier acceptance no longer counts.")
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  async function listAsset(kind: "ERC20" | "ERC721", token: string, id: string, rawAmount: string) {
    if (!trade || trade.executed) {
      setStatus("Open a trade, then drop the asset on You give.")
      return
    }
    if (!isAddress(token)) {
      setStatus("The token address is not valid. It must start with 0x.")
      return
    }
    const known = isSepoliaTestAsset(token) || isSchrodingerBox(token) || isAllowlisted(token, allowlist)
    if (!known && !acknowledged) {
      setStatus("This token is not one you have already accepted. Tick the confirmation, or remember it on this computer.")
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const signer = await walletSigner()
      const escrow = escrowContract(signer)
      if (kind === "ERC721") {
        const nft = new Contract(token, TEST_ERC721_ABI, signer)
        const approved = await nft.isApprovedForAll(await signer.getAddress(), escrowAddress)
        if (!approved) {
          setStatus("Approve this NFT collection for Atomic Barter, then it can be listed.")
          await (await nft.setApprovalForAll(escrowAddress, true)).wait()
        }
      } else {
        const erc20 = new Contract(token, TEST_ERC20_ABI, signer)
        const needed = BigInt(rawAmount)
        const allowance = await erc20.allowance(await signer.getAddress(), escrowAddress)
        if (allowance < needed) {
          setStatus("Approve this token amount for Atomic Barter, then it can be listed.")
          await (await erc20.approve(escrowAddress, needed)).wait()
        }
      }
      const tx = kind === "ERC721"
        ? await escrow.addNFT(tradeId, token, BigInt(id))
        : await escrow.addERC20(tradeId, token, BigInt(rawAmount))
      await tx.wait()
      setAcknowledged(false)
      await refresh()
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  function addAsset() {
    return listAsset(assetKind, assetAddress, tokenId, amount)
  }

  async function dropOnGive(event: DragEvent) {
    event.preventDefault()
    setDropOver(false)
    let payload: { kind?: string; tokenId?: string; amount?: string }
    try {
      payload = JSON.parse(event.dataTransfer.getData("text/plain"))
    } catch {
      return
    }
    if (payload.kind === "ERC721" && payload.tokenId) {
      setAssetKind("ERC721")
      setAssetAddress(SEPOLIA_TEST_ERC721)
      setTokenId(payload.tokenId)
      await listAsset("ERC721", SEPOLIA_TEST_ERC721, payload.tokenId, "1")
      return
    }
    if (payload.kind === "ERC20" && payload.amount) {
      setAssetKind("ERC20")
      setAssetAddress(SEPOLIA_TEST_ERC20)
      setAmount(payload.amount)
      await listAsset("ERC20", SEPOLIA_TEST_ERC20, "0", payload.amount)
    }
  }

  async function removeMine(index: number) {
    setBusy(true)
    setStatus(null)
    try {
      const escrow = await signerContract()
      const tx = await escrow.removeAsset(tradeId, index)
      await tx.wait()
      await refresh()
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!trade) return
    setBusy(true)
    setStatus(null)
    try {
      const escrow = await signerContract()
      const tx = await escrow.approveTrade(tradeId, trade.version)
      await tx.wait()
      await refresh()
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true)
    setStatus(null)
    try {
      const escrow = await signerContract()
      const tx = await escrow.cancelTrade(tradeId)
      await tx.wait()
      setTrade(null)
      setBundle(new Map())
      setBundleSource(null)
      setStatus("Trade cancelled. The assets stay in the wallets that held them.")
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  async function mintTestToken(kind: "ERC20" | "ERC721") {
    const tokenAddress = kind === "ERC20" ? SEPOLIA_TEST_ERC20 : SEPOLIA_TEST_ERC721
    if (!isAddress(tokenAddress)) {
      setStatus("The Sepolia test token is not in this build yet.")
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const signer = await walletSigner()
      const me = await signer.getAddress()
      if (kind === "ERC20") {
        const token = new Contract(tokenAddress, TEST_ERC20_ABI, signer)
        await (await token.mint(me, TEST_ERC20_MINT)).wait()
        setAssetKind("ERC20")
        setAssetAddress(tokenAddress)
        setAmount(TEST_ERC20_MINT.toString())
        setStatus("Created 1000 test tokens in your wallet. The amount below is in the token's smallest unit.")
      } else {
        const tokenId = BigInt(Date.now())
        const nft = new Contract(tokenAddress, TEST_ERC721_ABI, signer)
        await (await nft.mint(me, tokenId)).wait()
        setAssetKind("ERC721")
        setAssetAddress(tokenAddress)
        setTokenId(tokenId.toString())
        setStatus(`Created test NFT #${tokenId.toString()} in your wallet.`)
      }
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
    }
  }

  function trustAsset() {
    if (!isAddress(assetAddress)) return
    setAllowlist(saveAllowlist([...allowlist, assetAddress]))
    setAcknowledged(false)
  }

  const contentChanged = [...insides.values()].some((item) => item.changed)
  const youApproved = trade
    ? account?.toLowerCase() === trade.initiator.toLowerCase()
      ? trade.initiatorApproved
      : trade.counterpartyApproved
    : false
  const theyApproved = trade
    ? account?.toLowerCase() === trade.initiator.toLowerCase()
      ? trade.counterpartyApproved
      : trade.initiatorApproved
    : false

  return (
    <div className="min-h-screen bg-[#07080c] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.16),_transparent_42%)]" />
      <div className="relative">
        <SepoliaBanner account={account} chainId={chainId} onSwitch={connect} />
        <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
          <TradeForms
            account={account}
            busy={busy}
            counterparty={counterparty}
            deadlineInput={deadlineInput}
            escrowAddress={escrowAddress}
            tradeId={tradeId}
            onCounterparty={setCounterparty}
            onDeadline={setDeadlineInput}
            onEscrow={setEscrowAddress}
            onTradeId={setTradeId}
            onCreate={createTrade}
            onShow={() => refresh()}
          />
          <TradeList
            account={account}
            trades={knownTrades}
            checkedAt={checkedAt}
            onOpen={(id) => {
              setTradeId(id)
              void refresh(id).catch((error) => setStatus(explain(error)))
            }}
          />
          <BundleBoard
            trade={trade}
            youApproved={youApproved}
            theyApproved={theyApproved}
            bundleSource={bundleSource}
            contentChanged={contentChanged}
            busy={busy}
            myAssets={myAssets}
            theirAssets={theirAssets}
            insides={insides}
            dropOver={dropOver}
            onDragOver={(event) => {
              event.preventDefault()
              setDropOver(true)
            }}
            onDragLeave={() => setDropOver(false)}
            onDrop={(event) => void dropOnGive(event)}
            onRemove={trade && !trade.executed ? removeMine : undefined}
            onApprove={approve}
            onCancel={cancel}
          />
          <TestShelf
            account={account}
            busy={busy}
            canMintErc20={isAddress(SEPOLIA_TEST_ERC20)}
            canMintNft={isAddress(SEPOLIA_TEST_ERC721)}
            shelf={shelf}
            canDrag={Boolean(trade && !trade.executed)}
            onMintErc20={() => mintTestToken("ERC20")}
            onMintNft={() => mintTestToken("ERC721")}
          />
          <AddAssetForm
            kind={assetKind}
            address={assetAddress}
            tokenId={tokenId}
            amount={amount}
            unknown={unknownAsset}
            acknowledged={acknowledged}
            busy={busy}
            executed={Boolean(trade?.executed)}
            canAdd={canAddUnknown}
            onKind={setAssetKind}
            onAddress={setAssetAddress}
            onTokenId={setTokenId}
            onAmount={setAmount}
            onAck={setAcknowledged}
            onTrust={trustAsset}
            onAdd={addAsset}
          />
          {status && (
            <p className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-200">{status}</p>
          )}
        </main>
      </div>
    </div>
  )
}
