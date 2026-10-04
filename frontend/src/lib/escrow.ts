import { Contract, Interface } from "ethers"

export const ESCROW_ABI = [
  "function createTrade(address counterparty, uint256 deadline) returns (bytes32)",
  "function addNFT(bytes32 tradeId, address nftContract, uint256 tokenId)",
  "function addERC20(bytes32 tradeId, address tokenContract, uint256 amount)",
  "function removeAsset(bytes32 tradeId, uint256 index)",
  "function approveTrade(bytes32 tradeId, uint256 bundleVersion)",
  "function cancelTrade(bytes32 tradeId)",
  "function getTrade(bytes32 tradeId) view returns (address initiator, address counterparty, bool initiatorApproved, bool counterpartyApproved, bool executed, uint256 initiatorAssetCount, uint256 counterpartyAssetCount, uint256 deadline, uint256 version)",
  "function getAssets(bytes32 tradeId, address party) view returns (tuple(address contractAddress, uint256 tokenId, uint256 amount, uint8 assetType, bool sealedContainer, uint256 sealState, bytes32 contentHash)[])",
  "event TradeCreated(bytes32 indexed tradeId, address indexed initiator, address indexed counterparty, uint256 deadline)",
  "event AssetAdded(bytes32 indexed tradeId, address indexed owner, address indexed contractAddress, uint8 assetType, uint256 tokenId, uint256 amount, uint256 sealState, bytes32 contentHash)",
  "event AssetRemoved(bytes32 indexed tradeId, address indexed owner, address indexed contractAddress, uint256 tokenId, uint256 amount)",
  "event TradeApproved(bytes32 indexed tradeId, address indexed party, uint256 bundleVersion)",
  "event TradeCompleted(bytes32 indexed tradeId)",
  "event TradeCancelled(bytes32 indexed tradeId)",
] as const

export interface ListedAsset {
  owner: string
  contractAddress: string
  assetType: number
  tokenId: bigint
  amount: bigint
  sealedContainer?: boolean
  sealState?: bigint
}

export interface BundleLog {
  name: "AssetAdded" | "AssetRemoved"
  owner: string
  contractAddress: string
  assetType: number
  tokenId: bigint
  amount: bigint
  blockNumber: number
  transactionIndex: number
  logIndex: number
}

const ALLOWLIST_KEY = "atomic-barter.allowlist"

const OLD_ASSETS = new Interface([
  "function getAssets(bytes32 tradeId, address party) view returns (tuple(address contractAddress, uint256 tokenId, uint256 amount, uint8 assetType)[])",
])
const SEAL_ASSETS = new Interface([
  "function getAssets(bytes32 tradeId, address party) view returns (tuple(address contractAddress, uint256 tokenId, uint256 amount, uint8 assetType, bool sealedContainer, uint256 sealState)[])",
])
const HASH_ASSETS = new Interface([
  "function getAssets(bytes32 tradeId, address party) view returns (tuple(address contractAddress, uint256 tokenId, uint256 amount, uint8 assetType, bool sealedContainer, uint256 sealState, bytes32 contentHash)[])",
])

export async function readStoredAssets(escrow: Contract, tradeId: string, party: string) {
  const to = await escrow.getAddress()
  const data = OLD_ASSETS.encodeFunctionData("getAssets", [tradeId, party])
  const runner = escrow.runner as { call?: (tx: { to: string; data: string }) => Promise<string>; provider?: { call?: (tx: { to: string; data: string }) => Promise<string> } } | null
  const call = runner && typeof runner.call === "function"
    ? runner.call.bind(runner)
    : runner?.provider?.call?.bind(runner.provider)
  if (!call) return escrow.getAssets.staticCall(tradeId, party)
  const raw = await call({ to, data })
  try {
    return HASH_ASSETS.decodeFunctionResult("getAssets", raw)[0]
  } catch {
    try {
      return SEAL_ASSETS.decodeFunctionResult("getAssets", raw)[0]
    } catch {
      return OLD_ASSETS.decodeFunctionResult("getAssets", raw)[0]
    }
  }
}

export function loadAllowlist(): string[] {
  try {
    const raw = localStorage.getItem(ALLOWLIST_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.map((entry) => String(entry).toLowerCase())
  } catch {
    return []
  }
}

export function saveAllowlist(addresses: string[]) {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))]
  localStorage.setItem(ALLOWLIST_KEY, JSON.stringify(unique))
  return unique
}

export function isAllowlisted(address: string, list: string[]) {
  return list.includes(address.toLowerCase())
}

/**
 * Rebuilds each party's bundle from AssetAdded and AssetRemoved.
 * Settlement deletes the on-chain arrays, so a completed trade has to be read from these logs.
 */
export function bundleFromLogs(logs: BundleLog[]): Map<string, ListedAsset[]> {
  const ordered = [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
    if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex
    return a.logIndex - b.logIndex
  })

  const lists = new Map<string, ListedAsset[]>()
  for (const log of ordered) {
    const key = log.owner.toLowerCase()
    const list = lists.get(key) ?? []
    if (log.name === "AssetAdded") {
      list.push({
        owner: log.owner,
        contractAddress: log.contractAddress,
        assetType: log.assetType,
        tokenId: log.tokenId,
        amount: log.amount,
      })
    } else {
      const index = list.findIndex(
        (item) =>
          item.contractAddress.toLowerCase() === log.contractAddress.toLowerCase() &&
          item.tokenId === log.tokenId &&
          item.amount === log.amount,
      )
      if (index >= 0) list.splice(index, 1)
    }
    lists.set(key, list)
  }
  return lists
}

export function assetsFor(lists: Map<string, ListedAsset[]>, owner: string) {
  return lists.get(owner.toLowerCase()) ?? []
}
