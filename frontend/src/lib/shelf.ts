import { Contract, EventLog, formatUnits, type Provider } from "ethers"
import { ESCROW_ABI } from "./escrow"
import { SEPOLIA_TEST_ERC20, SEPOLIA_TEST_ERC721 } from "./sepolia"

const LOOKBACK = 200_000

const BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]

const TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]

export interface Shelf {
  symbol: string
  decimals: number
  balance: bigint
  nftIds: bigint[]
}

export interface KnownTrade {
  tradeId: string
  initiator: string
  counterparty: string
  executed: boolean
  cancelled: boolean
  deadline: bigint
  version: bigint
}

function fromBlock(latest: number) {
  return Math.max(0, latest - LOOKBACK)
}

export function formatTokenAmount(amount: bigint, decimals: number) {
  const [whole, fraction = ""] = formatUnits(amount, decimals).split(".")
  const trimmed = fraction.replace(/0+$/, "").slice(0, 4)
  return trimmed ? `${whole}.${trimmed}` : whole
}

export async function loadShelf(provider: Provider, account: string): Promise<Shelf> {
  const token = new Contract(SEPOLIA_TEST_ERC20, BALANCE_ABI, provider)
  const nft = new Contract(SEPOLIA_TEST_ERC721, TRANSFER_ABI, provider)
  const latest = await provider.getBlockNumber()
  const start = fromBlock(latest)
  const [symbol, decimals, balance, incoming, outgoing] = await Promise.all([
    token.symbol().catch(() => "MOCK"),
    token.decimals().catch(() => 18n),
    token.balanceOf(account),
    nft.queryFilter(nft.filters.Transfer(null, account), start),
    nft.queryFilter(nft.filters.Transfer(account, null), start),
  ])

  const owned = new Set<string>()
  const events = [...incoming, ...outgoing].sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index)
  for (const entry of events) {
    if (!(entry instanceof EventLog)) continue
    const id = entry.args.tokenId.toString()
    if (String(entry.args.to).toLowerCase() === account.toLowerCase()) owned.add(id)
    else owned.delete(id)
  }

  return {
    symbol: String(symbol),
    decimals: Number(decimals),
    balance,
    nftIds: [...owned].map((id) => BigInt(id)),
  }
}

export async function loadTrades(provider: Provider, escrowAddress: string, account: string): Promise<KnownTrade[]> {
  const escrow = new Contract(escrowAddress, ESCROW_ABI, provider)
  const latest = await provider.getBlockNumber()
  const start = fromBlock(latest)
  const [started, joined] = await Promise.all([
    escrow.queryFilter(escrow.filters.TradeCreated(null, account), start),
    escrow.queryFilter(escrow.filters.TradeCreated(null, null, account), start),
  ])

  const ids = new Map<string, { initiator: string; counterparty: string }>()
  for (const entry of [...started, ...joined]) {
    if (!(entry instanceof EventLog)) continue
    ids.set(String(entry.args.tradeId), {
      initiator: String(entry.args.initiator),
      counterparty: String(entry.args.counterparty),
    })
  }

  const trades: KnownTrade[] = []
  for (const [tradeId, parties] of ids) {
    try {
      const row = await escrow.getTrade(tradeId)
      trades.push({
        tradeId,
        initiator: String(row[0]),
        counterparty: String(row[1]),
        executed: Boolean(row[4]),
        cancelled: false,
        deadline: row[7],
        version: row[8],
      })
    } catch {
      trades.push({
        tradeId,
        initiator: parties.initiator,
        counterparty: parties.counterparty,
        executed: false,
        cancelled: true,
        deadline: 0n,
        version: 0n,
      })
    }
  }
  return trades
}
