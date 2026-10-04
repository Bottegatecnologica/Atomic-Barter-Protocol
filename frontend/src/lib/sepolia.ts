import addresses from "./sepolia.addresses.json"

export const SEPOLIA_CHAIN_ID = addresses.chainId
export const SEPOLIA_ESCROW = addresses.escrow
export const SEPOLIA_TEST_ERC20 = addresses.testErc20
export const SEPOLIA_TEST_ERC721 = addresses.testErc721

/** Escrows that no longer enforce the current seal rules. Revoke approvals left on them. */
export const PREVIOUS_ESCROWS = [
  "0x11dFdDDF9393F01d73c85c50245f5A979209B656",
  "0xcEC6Ed6B834e0dF429A12F6a30fa0Dec14a9b5D5",
  "0x6819ec835bE28B16Bd63AfBB52C8955FA0AC650b",
  "0xFc58343cb7458b4eF8a6D41E532BD49386d04189",
]

const SEPOLIA_HEX = "0xaa36a7"

export const TEST_ERC20_MINT = 1000n * 10n ** 18n

export const TEST_ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const

export const TEST_ERC721_ABI = [
  "function mint(address to, uint256 tokenId)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
] as const

export function isSepoliaTestAsset(address: string) {
  const value = address.toLowerCase()
  return [SEPOLIA_TEST_ERC20, SEPOLIA_TEST_ERC721].some((item) => item !== "" && item.toLowerCase() === value)
}

export async function ensureSepolia() {
  const ethereum = window.ethereum
  if (!ethereum) throw new Error("Connect a wallet first.")
  const current = await ethereum.request({ method: "eth_chainId" })
  if (typeof current === "string" && Number.parseInt(current, 16) === SEPOLIA_CHAIN_ID) return
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : 0
    if (code !== 4902) throw error
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: SEPOLIA_HEX,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        },
      ],
    })
  }
}
