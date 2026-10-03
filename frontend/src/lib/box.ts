import { Contract, formatUnits, type Provider } from "ethers"
import type { ListedAsset } from "./escrow"

const BOXES = [
  "0x826c31473B3f69a04A6c0335E3c5Fd342571Eb61",
  "0xe3223C7b87Cf9355b09B69c800F6AE34C80c332e",
]

const PAR = new Set([
  "0xc3bcabf7dc96220f11ebdd895811448bc029c8b6",
  "0x5cc4d1a7faeee5c8517ba34fa5299d06e34e9cb9",
])

const CATS = new Set([
  "0x37504282f31d230236782472e8a7389ae6aea8f1",
  "0xe45237949f2dee32ea271f8c67d01d834e8ef2a3",
])

const BOX_ABI = [
  "function getBoxDetails(uint256 boxId) view returns (address[] erc20Tokens, uint256[] erc20Amounts, address[] erc721Contracts, uint256[] erc721TokenIds, bool isLocked, uint16 originChain, bool isOriginal, uint256 originBoxId)",
  "event ERC20Deposited(uint256 indexed boxId, address indexed token, uint256 amount)",
  "event ERC20Withdrawn(uint256 indexed boxId, address indexed token, uint256 amount)",
  "event NFTDeposited(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId)",
  "event NFTWithdrawn(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId)",
] as const

export interface BoxInside {
  lines: string[]
  changed: boolean
  locked: boolean
  unread: boolean
}

export function isSchrodingerBox(address: string) {
  return BOXES.some((item) => item.toLowerCase() === address.toLowerCase())
}

export function boxKey(contractAddress: string, tokenId: bigint) {
  return `${contractAddress.toLowerCase()}:${tokenId.toString()}`
}

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function amountText(value: bigint) {
  const text = formatUnits(value, 18)
  if (!text.includes(".")) return text
  return text.replace(/0+$/, "").replace(/\.$/, "")
}

function describe(details: {
  erc20Tokens: string[]
  erc20Amounts: bigint[]
  erc721Contracts: string[]
  erc721TokenIds: bigint[]
  isLocked: boolean
}) {
  const lines = details.erc20Tokens.map((token, index) => {
    const amount = details.erc20Amounts[index]
    const name = PAR.has(token.toLowerCase()) ? "PAR" : short(token)
    const shown = PAR.has(token.toLowerCase()) ? amountText(amount) : amount.toString()
    return `${name} ${shown}`
  })
  details.erc721Contracts.forEach((token, index) => {
    const id = details.erc721TokenIds[index].toString()
    lines.push(CATS.has(token.toLowerCase()) ? `Cat #${id}` : `${short(token)} #${id}`)
  })
  if (lines.length === 0) lines.push("Empty")
  if (details.isLocked) lines.unshift("Locked")
  return lines
}

export async function readBoxInsides(
  provider: Provider,
  assets: ListedAsset[],
  listedAt: Map<string, number>,
): Promise<Map<string, BoxInside>> {
  const found = new Map<string, BoxInside>()
  const boxes = assets.filter((asset) => asset.assetType === 1 && isSchrodingerBox(asset.contractAddress))
  await Promise.all(boxes.map(async (asset) => {
    const key = boxKey(asset.contractAddress, asset.tokenId)
    const contract = new Contract(asset.contractAddress, BOX_ABI, provider)
    try {
      const details = await contract.getBoxDetails(asset.tokenId)
      let changed = false
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
          changed = logs.some((list) => list.length > 0)
        }
      }
      found.set(key, {
        lines: describe(details),
        changed,
        locked: Boolean(details.isLocked),
        unread: false,
      })
    } catch {
      found.set(key, {
        lines: ["Could not read what is inside."],
        changed: false,
        locked: false,
        unread: true,
      })
    }
  }))
  return found
}
