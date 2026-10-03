import { useEffect, useMemo, useState, type ReactNode } from "react"
import { BrowserProvider, Contract, EventLog, isAddress, type Eip1193Provider } from "ethers"
import { ShieldAlert, Wallet2 } from "lucide-react"
import Button from "./ui/button"
import {
  ESCROW_ABI,
  assetsFor,
  bundleFromLogs,
  isAllowlisted,
  loadAllowlist,
  saveAllowlist,
  type BundleLog,
  type ListedAsset,
} from "../lib/escrow"
import {
  SEPOLIA_ESCROW,
  SEPOLIA_TEST_ERC20,
  SEPOLIA_TEST_ERC721,
  TEST_ERC20_ABI,
  TEST_ERC20_MINT,
  TEST_ERC721_ABI,
  ensureSepolia,
  isSepoliaTestAsset,
} from "../lib/sepolia"

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

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatAsset(asset: ListedAsset) {
  if (asset.assetType === 1) {
    return `NFT ${shortAddress(asset.contractAddress)} #${asset.tokenId.toString()}`
  }
  return `${asset.amount.toString()} of token ${shortAddress(asset.contractAddress)}`
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

function mapStoredAssets(owner: string, rows: Array<{ contractAddress: string; tokenId: bigint; amount: bigint; assetType: number }>) {
  return rows.map((row) => ({
    owner,
    contractAddress: row.contractAddress,
    tokenId: row.tokenId,
    amount: row.amount,
    assetType: Number(row.assetType),
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
  const [bundleSource, setBundleSource] = useState<"storage" | "events" | null>(null)
  const [assetKind, setAssetKind] = useState<"ERC20" | "ERC721">("ERC721")
  const [assetAddress, setAssetAddress] = useState("")
  const [tokenId, setTokenId] = useState("")
  const [amount, setAmount] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAllowlist(loadAllowlist())
  }, [])

  useEffect(() => {
    setAcknowledged(false)
  }, [assetAddress])

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

  async function connect() {
    if (!window.ethereum) {
      setStatus("This browser has no wallet. Install one and reload the page.")
      return
    }
    try {
      await ensureSepolia()
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider)
      const signer = await provider.getSigner()
      setAccount(await signer.getAddress())
    } catch (error) {
      setStatus(explain(error))
    }
  }

  async function walletSigner() {
    if (!window.ethereum) throw new Error("Connect a wallet first.")
    await ensureSepolia()
    const provider = new BrowserProvider(window.ethereum as Eip1193Provider)
    return provider.getSigner()
  }

  function escrowContract(signerOrProvider: BrowserProvider | Awaited<ReturnType<BrowserProvider["getSigner"]>>) {
    if (!isAddress(escrowAddress)) throw new Error("Paste the Atomic Barter contract address first.")
    return new Contract(escrowAddress, ESCROW_ABI, signerOrProvider)
  }

  async function signerContract() {
    return escrowContract(await walletSigner())
  }

  async function refresh(id = tradeId) {
    if (!isAddress(escrowAddress) || !id.startsWith("0x") || id.length !== 66) return
    if (!window.ethereum) throw new Error("Connect a wallet to read the trade.")
    await ensureSepolia()
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
    if (view.executed) {
      setBundle(await readSettledBundle(escrow, id))
      setBundleSource("events")
      return
    }
    const [left, right] = await Promise.all([
      escrow.getAssets(id, view.initiator),
      escrow.getAssets(id, view.counterparty),
    ])
    const lists = new Map<string, ListedAsset[]>()
    lists.set(view.initiator.toLowerCase(), mapStoredAssets(view.initiator, left))
    lists.set(view.counterparty.toLowerCase(), mapStoredAssets(view.counterparty, right))
    setBundle(lists)
    setBundleSource("storage")
  }

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

  async function addAsset() {
    if (!trade || trade.executed) {
      setStatus("Create a trade, or open an existing one. Then you can add the asset.")
      return
    }
    if (!isAddress(assetAddress)) {
      setStatus("The token address is not valid. It must start with 0x.")
      return
    }
    if (!canAddUnknown) {
      setStatus("This token is not one you have already accepted. Tick the confirmation, or remember it on this computer.")
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const signer = await walletSigner()
      const escrow = escrowContract(signer)
      if (assetKind === "ERC721") {
        const nft = new Contract(assetAddress, TEST_ERC721_ABI, signer)
        const approved = await nft.isApprovedForAll(await signer.getAddress(), escrowAddress)
        if (!approved) {
          setStatus("Approve this NFT collection for Atomic Barter, then it can be listed.")
          await (await nft.setApprovalForAll(escrowAddress, true)).wait()
        }
      } else {
        const token = new Contract(assetAddress, TEST_ERC20_ABI, signer)
        const needed = BigInt(amount)
        const allowance = await token.allowance(await signer.getAddress(), escrowAddress)
        if (allowance < needed) {
          setStatus("Approve this token amount for Atomic Barter, then it can be listed.")
          await (await token.approve(escrowAddress, needed)).wait()
        }
      }
      const tx = assetKind === "ERC721"
        ? await escrow.addNFT(tradeId, assetAddress, BigInt(tokenId))
        : await escrow.addERC20(tradeId, assetAddress, BigInt(amount))
      await tx.wait()
      setAcknowledged(false)
      await refresh()
    } catch (error) {
      setStatus(explain(error))
    } finally {
      setBusy(false)
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
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(251,191,36,0.08),_transparent_45%)]" />
      <div className="relative">
        <header className="border-b border-white/10">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-400/15 text-amber-300">
                <Wallet2 className="h-5 w-5" />
              </span>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Atomic Barter</h1>
                <p className="text-xs text-zinc-400">Assets move only when both of you accept the same list.</p>
              </div>
            </div>
            <Button onClick={connect}>{account ? shortAddress(account) : "Connect wallet"}</Button>
          </div>
        </header>

        <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="text-base font-semibold">New trade</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Enter the other person's address and how long the offer stays open. You need a connected wallet.
              </p>
              <div className="mt-4 space-y-3">
                <Field label="Who you trade with" hint="Their wallet address, not yours.">
                  <input
                    className={`${fieldClass} font-mono`}
                    value={counterparty}
                    onChange={(event) => setCounterparty(event.target.value.trim())}
                    placeholder="0x…"
                  />
                </Field>
                <Field label="Expires" hint="After this time you can only cancel.">
                  <input
                    className={fieldClass}
                    type="datetime-local"
                    value={deadlineInput}
                    onChange={(event) => setDeadlineInput(event.target.value)}
                  />
                </Field>
                <Button disabled={busy || !account} onClick={createTrade}>
                  Create trade
                </Button>
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="text-base font-semibold">Existing trade</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Paste the contract address and the code the other person sent you. If you created the trade, the code appears here after your wallet confirms.
              </p>
              <div className="mt-4 space-y-3">
                <Field label="Atomic Barter contract" hint="The contract address on this network. Whoever published it can give it to you.">
                  <input
                    className={`${fieldClass} font-mono`}
                    value={escrowAddress}
                    onChange={(event) => setEscrowAddress(event.target.value.trim())}
                    placeholder="0x…"
                  />
                </Field>
                <div>
                  <Field label="Trade code" hint="A long value that starts with 0x.">
                    <input
                      className={`${fieldClass} font-mono`}
                      value={tradeId}
                      onChange={(event) => setTradeId(event.target.value.trim())}
                      placeholder="0x…"
                    />
                  </Field>
                  <div className="mt-3">
                    <Button variant="outline" disabled={busy || !account} onClick={() => refresh()}>
                      Show trade
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="rounded-2xl border border-white/10 bg-[#101218] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">What is being traded</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  {trade
                    ? "Check both lists before you accept. If someone adds or removes an asset, you have to accept again."
                    : "This shows what you give and what you receive. Create a trade first, or open one with its code."}
                </p>
              </div>
              {trade && (
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${trade.executed ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-200"}`}>
                  {trade.executed ? "Settled" : "Open"} · version {trade.version.toString()}
                </span>
              )}
            </div>

            {trade && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <Pill on={youApproved} label="You accepted" />
                <Pill on={theyApproved} label="They accepted" />
                <span className="rounded-full border border-white/10 px-3 py-1 text-zinc-300">
                  Expires {new Date(Number(trade.deadline) * 1000).toLocaleString()}
                </span>
              </div>
            )}

            {trade && !trade.executed && (
              <p className="mt-4 text-sm text-zinc-400">
                An NFT is sent with a normal transfer. If the other side is a contract that cannot send NFTs onward, the NFT can get stuck there.
              </p>
            )}

            {bundleSource === "events" && (
              <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                This trade is already settled. The contract cleared its lists, so the assets below are the ones that were added and not removed.
              </p>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <AssetColumn title="You give" assets={myAssets} onRemove={trade && !trade.executed ? removeMine : undefined} />
              <AssetColumn title="You receive" assets={theirAssets} />
            </div>

            {trade && !trade.executed && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={approve}>
                  I accept version {trade.version.toString()}
                </Button>
                <Button variant="outline" disabled={busy} onClick={cancel}>
                  Cancel trade
                </Button>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-base font-semibold">Sepolia test assets</h2>
            <p className="mt-1 text-sm text-zinc-400">
              These tokens have no value. Creating one mints it to the connected wallet and fills the form below, so you can list it in the open trade.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={busy || !account || !isAddress(SEPOLIA_TEST_ERC20)} onClick={() => mintTestToken("ERC20")}>
                Create test ERC-20
              </Button>
              <Button disabled={busy || !account || !isAddress(SEPOLIA_TEST_ERC721)} onClick={() => mintTestToken("ERC721")}>
                Create test NFT
              </Button>
            </div>
            {!isAddress(SEPOLIA_ESCROW) && (
              <p className="mt-3 text-sm text-amber-100">The Sepolia contracts are not in this build yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-base font-semibold">Add an asset</h2>
            <p className="mt-1 text-sm text-zinc-400">
              It goes on the You give list. An NFT needs the token number. An ERC-20 needs the amount in the token's smallest unit, such as wei.
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant={assetKind === "ERC721" ? "default" : "outline"} onClick={() => setAssetKind("ERC721")}>
                NFT
              </Button>
              <Button variant={assetKind === "ERC20" ? "default" : "outline"} onClick={() => setAssetKind("ERC20")}>
                ERC-20
              </Button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70 sm:col-span-2"
                value={assetAddress}
                onChange={(event) => setAssetAddress(event.target.value.trim())}
                placeholder="Token address, 0x…"
              />
              {assetKind === "ERC721" ? (
                <input
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70"
                  value={tokenId}
                  onChange={(event) => setTokenId(event.target.value)}
                  placeholder="NFT number"
                />
              ) : (
                <input
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="Amount, smallest unit"
                />
              )}
            </div>
            {unknownAsset && (
              <div className="mt-3 space-y-3 rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                <p className="flex gap-2">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    This token is not one you have already accepted. It can lie about how many you hold, or who owns an NFT, and the trade cannot tell.
                  </span>
                </p>
                <label className="flex items-start gap-2 text-amber-50">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I checked it. It is fine for this trade.
                </label>
                <Button variant="outline" onClick={trustAsset}>
                  Remember it on this computer
                </Button>
              </div>
            )}
            <div className="mt-3">
              <Button disabled={busy || trade?.executed || !canAddUnknown} onClick={addAsset}>
                Add it to my list
              </Button>
            </div>
          </section>

          {status && (
            <p className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-200">{status}</p>
          )}
        </main>
      </div>
    </div>
  )
}

const fieldClass =
  "mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-amber-300/70"

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-200">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
      {children}
    </label>
  )
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`rounded-full px-3 py-1 ${on ? "bg-emerald-400/15 text-emerald-300" : "bg-white/5 text-zinc-400"}`}>
      {label}: {on ? "yes" : "not yet"}
    </span>
  )
}

function AssetColumn({
  title,
  assets,
  onRemove,
}: {
  title: string
  assets: ListedAsset[]
  onRemove?: (index: number) => void
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
      {assets.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {assets.map((asset, index) => (
            <li key={`${asset.contractAddress}-${asset.tokenId}-${asset.amount}-${index}`} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.04] px-3 py-2">
              <span className="font-mono text-xs text-zinc-200">{formatAsset(asset)}</span>
              {onRemove && (
                <Button variant="ghost" onClick={() => onRemove(index)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
