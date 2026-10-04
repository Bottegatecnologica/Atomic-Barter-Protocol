import { Contract, formatUnits, getAddress, isAddress, type Provider } from "ethers"
import type { ListedAsset } from "./escrow"
import { SEPOLIA_CHAIN_ID, SEPOLIA_TEST_ERC20, SEPOLIA_TEST_ERC721 } from "./sepolia"

/** Sepolia boxes from earlier deploys. They are not the live pair. */
export const PREVIOUS_SEPOLIA_BOXES = [
  "0x29733d284ba67EC96D43966C575f26437aF0aF73",
  "0x4642836001Ab04ebDf65f1780F5FB5E297e33990",
  "0x352167e7A42C69401F705005d179d18892D115F2",
  "0xe8De9D30ae05f176b5970559ad961958A5447831",
]

/** Current peered boxes, keyed by the chain the wallet is on. */
export const BOXES_BY_CHAIN: Record<number, string[]> = {
  11155111: ["0x0D0aD3b2698ab55217fFb7428A8bE7Ac8e8041f9"],
  84532: ["0x7c44c66c7F93Fa84dDeCd747E427fe3E4818cCE2"],
}

const PAR = new Set([
  "0xc3bcabf7dc96220f11ebdd895811448bc029c8b6",
  "0x5cc4d1a7faeee5c8517ba34fa5299d06e34e9cb9",
])

const CATS = new Set([
  "0x37504282f31d230236782472e8a7389ae6aea8f1",
  "0xe45237949f2dee32ea271f8c67d01d834e8ef2a3",
])

const CHAINS: Record<number, string> = {
  10002: "Ethereum Sepolia",
  10004: "Base Sepolia",
}

const MAX_DEPTH = 4

const BOX_ABI = [
  "function getBoxDetails(uint256 boxId) view returns (tuple(address contractAddress, uint256 tokenId, uint256 amount, uint8 assetType)[] assets, bool isLocked, uint16 originChain, bool isOriginal, uint256 originBoxId)",
  "function isSealed(uint256 tokenId) view returns (bool)",
  "function sealState(uint256 tokenId) view returns (uint256)",
  "event ERC20Deposited(uint256 indexed boxId, address indexed token, uint256 amount)",
  "event ERC20Withdrawn(uint256 indexed boxId, address indexed token, uint256 amount)",
  "event NFTDeposited(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId)",
  "event NFTWithdrawn(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId)",
] as const

const ERC20_META = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
] as const

const SYMBOL_ABI = ["function symbol() view returns (string)"] as const

export interface BoxNode {
  text: string
  shadow: boolean
  origin: string
  children: BoxNode[]
}

export interface BoxInside {
  nodes: BoxNode[]
  changed: boolean
  locked: boolean
  unread: boolean
  shadow: boolean
  originChain: number
  originBoxId: string
}

export interface AssetFace {
  primary: string
  address: string
  warning?: string
}

export function isSchrodingerBox(address: string, chainId = SEPOLIA_CHAIN_ID) {
  return (BOXES_BY_CHAIN[chainId] ?? []).some((item) => item.toLowerCase() === address.toLowerCase())
}

export function boxKey(contractAddress: string, tokenId: bigint) {
  return `${contractAddress.toLowerCase()}:${tokenId.toString()}`
}

function checksum(address: string) {
  if (!isAddress(address)) return address
  return getAddress(address)
}

function chainName(id: number) {
  return CHAINS[id] ?? `Wormhole chain ${id}`
}

function amountText(value: bigint, decimals: number) {
  if (decimals <= 0) return value.toString()
  const text = formatUnits(value, decimals)
  if (!text.includes(".")) return text
  return text.replace(/0+$/, "").replace(/\.$/, "")
}

async function readSymbol(provider: Provider, address: string) {
  try {
    const symbol = await new Contract(address, SYMBOL_ABI, provider).symbol()
    return String(symbol)
  } catch {
    return ""
  }
}

let knownSymbols: Map<string, Set<string>> | null = null

async function loadKnownSymbols(provider: Provider) {
  if (knownSymbols) return knownSymbols
  const found = new Map<string, Set<string>>()
  const remember = (symbol: string, address: string) => {
    const key = symbol.trim().toUpperCase()
    if (!key) return
    const set = found.get(key) ?? new Set<string>()
    set.add(address.toLowerCase())
    found.set(key, set)
  }
  for (const address of PAR) remember("PAR", address)
  for (const list of Object.values(BOXES_BY_CHAIN)) {
    for (const address of list) remember("SBOX", address)
  }
  for (const address of [SEPOLIA_TEST_ERC20, SEPOLIA_TEST_ERC721]) {
    if (!address || !isAddress(address)) continue
    remember(await readSymbol(provider, address), address)
  }
  knownSymbols = found
  return found
}

function spoofWarning(symbol: string, address: string, known: Map<string, Set<string>>) {
  const set = known.get(symbol.trim().toUpperCase())
  if (!set || set.size === 0) return undefined
  if (set.has(address.toLowerCase())) return undefined
  return `The symbol ${symbol} matches a known token, but this address is different.`
}

async function plainText(provider: Provider, asset: { contractAddress: string; tokenId: bigint; amount: bigint; assetType: number | bigint }, known: Map<string, Set<string>>, chainId: number) {
  const address = checksum(asset.contractAddress)
  if (Number(asset.assetType) === 0) {
    if (PAR.has(asset.contractAddress.toLowerCase())) return `PAR ${amountText(asset.amount, 18)}`
    const token = new Contract(asset.contractAddress, ERC20_META, provider)
    try {
      const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
      const warning = spoofWarning(String(symbol), asset.contractAddress, known)
      const shown = `${symbol} ${amountText(asset.amount, Number(decimals))}`
      return warning ? `${shown} (${warning})` : shown
    } catch {
      return `Token ${address} · ${asset.amount.toString()}`
    }
  }
  const id = asset.tokenId.toString()
  if (CATS.has(asset.contractAddress.toLowerCase())) return `Cat #${id}`
  if (isSchrodingerBox(asset.contractAddress, chainId)) return `Box #${id}`
  const symbol = await readSymbol(provider, asset.contractAddress)
  return symbol ? `${symbol} #${id}` : `NFT ${address} #${id}`
}

async function readNodes(
  provider: Provider,
  boxAddress: string,
  tokenId: bigint,
  depth: number,
  seen: Set<string>,
  known: Map<string, Set<string>>,
  chainId: number,
): Promise<{ nodes: BoxNode[]; shadow: boolean; originChain: number; originBoxId: string; locked: boolean }> {
  const key = boxKey(boxAddress, tokenId)
  const empty = { nodes: [] as BoxNode[], shadow: false, originChain: 0, originBoxId: "0", locked: false }
  if (depth >= MAX_DEPTH) {
    return { ...empty, nodes: [{ text: "Deeper boxes are not shown.", shadow: false, origin: "", children: [] }] }
  }
  if (seen.has(key)) {
    return { ...empty, nodes: [{ text: "This box is already shown above.", shadow: false, origin: "", children: [] }] }
  }
  seen.add(key)
  const contract = new Contract(boxAddress, BOX_ABI, provider)
  const details = await contract.getBoxDetails(tokenId)
  const shadow = !Boolean(details.isOriginal)
  const nodes: BoxNode[] = []
  for (const asset of details.assets) {
    if (shadow) {
      const kind = Number(asset.assetType) === 0 ? "Token" : "NFT"
      const id = Number(asset.assetType) === 0 ? asset.amount.toString() : `#${asset.tokenId.toString()}`
      nodes.push({
        text: `${kind} ${checksum(asset.contractAddress)} ${id} on ${chainName(Number(details.originChain))}`,
        shadow: false,
        origin: "",
        children: [],
      })
      continue
    }
    if (Number(asset.assetType) === 1 && isSchrodingerBox(asset.contractAddress, chainId)) {
      try {
        const inner = await readNodes(provider, asset.contractAddress, asset.tokenId, depth + 1, seen, known, chainId)
        nodes.push({
          text: `Box #${asset.tokenId.toString()}`,
          shadow: inner.shadow,
          origin: inner.shadow ? `Shadow of #${inner.originBoxId} on ${chainName(inner.originChain)}` : "",
          children: inner.nodes,
        })
      } catch {
        nodes.push({ text: `Box #${asset.tokenId.toString()} could not be read.`, shadow: false, origin: "", children: [] })
      }
      continue
    }
    nodes.push({
      text: await plainText(provider, asset, known, chainId),
      shadow: false,
      origin: "",
      children: [],
    })
  }
  if (nodes.length === 0) nodes.push({ text: "Empty", shadow: false, origin: "", children: [] })
  return {
    nodes,
    shadow,
    originChain: Number(details.originChain),
    originBoxId: details.originBoxId.toString(),
    locked: Boolean(details.isLocked),
  }
}

export async function labelAssets(provider: Provider, assets: ListedAsset[], chainId = SEPOLIA_CHAIN_ID): Promise<AssetFace[]> {
  const known = await loadKnownSymbols(provider)
  return Promise.all(assets.map(async (asset) => {
    const address = checksum(asset.contractAddress)
    if (asset.assetType === 1 && isSchrodingerBox(asset.contractAddress, chainId)) {
      return { primary: `Schrödinger's Box #${asset.tokenId.toString()}`, address }
    }
    if (asset.assetType === 1) {
      const symbol = await readSymbol(provider, asset.contractAddress)
      const warning = symbol ? spoofWarning(symbol, asset.contractAddress, known) : undefined
      return {
        primary: symbol ? `${symbol} #${asset.tokenId.toString()}` : `NFT #${asset.tokenId.toString()}`,
        address,
        warning,
      }
    }
    const token = new Contract(asset.contractAddress, ERC20_META, provider)
    try {
      const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
      return {
        primary: `${symbol} ${amountText(asset.amount, Number(decimals))}`,
        address,
        warning: spoofWarning(String(symbol), asset.contractAddress, known),
      }
    } catch {
      return { primary: asset.amount.toString(), address }
    }
  }))
}

export async function readBoxInsides(
  provider: Provider,
  assets: ListedAsset[],
  listedAt: Map<string, number>,
  chainId = SEPOLIA_CHAIN_ID,
): Promise<Map<string, BoxInside>> {
  const found = new Map<string, BoxInside>()
  const known = await loadKnownSymbols(provider)
  const boxes = assets.filter((asset) => asset.assetType === 1 && isSchrodingerBox(asset.contractAddress, chainId))
  await Promise.all(boxes.map(async (asset) => {
    const key = boxKey(asset.contractAddress, asset.tokenId)
    const contract = new Contract(asset.contractAddress, BOX_ABI, provider)
    try {
      const tree = await readNodes(provider, asset.contractAddress, asset.tokenId, 0, new Set(), known, chainId)
      let changed = false
      if (asset.sealedContainer) {
        try {
          const [sealed, state] = await Promise.all([
            contract.isSealed(asset.tokenId),
            contract.sealState(asset.tokenId),
          ])
          if (!sealed || (asset.sealState !== undefined && state !== asset.sealState)) changed = true
        } catch {
          changed = true
        }
      }
      const from = listedAt.get(key)
      if (from !== undefined) {
        const latest = await provider.getBlockNumber()
        if (latest > from) {
          const filters = [
            contract.filters.ERC20Deposited(asset.tokenId),
            contract.filters.ERC20Withdrawn(asset.tokenId),
            contract.filters.NFTDeposited(asset.tokenId),
            contract.filters.NFTWithdrawn(asset.tokenId),
          ]
          const logs = await Promise.all(filters.map((filter) => contract.queryFilter(filter, from + 1, latest)))
          if (logs.some((list) => list.length > 0)) changed = true
        }
      }
      found.set(key, {
        nodes: tree.nodes,
        changed,
        locked: tree.locked,
        unread: false,
        shadow: tree.shadow,
        originChain: tree.originChain,
        originBoxId: tree.originBoxId,
      })
    } catch {
      found.set(key, {
        nodes: [{ text: "Could not read what is inside.", shadow: false, origin: "", children: [] }],
        changed: false,
        locked: false,
        unread: true,
        shadow: false,
        originChain: 0,
        originBoxId: "0",
      })
    }
  }))
  return found
}
