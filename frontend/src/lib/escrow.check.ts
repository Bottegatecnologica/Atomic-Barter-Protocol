import { bundleFromLogs, type BundleLog } from "./escrow.ts"

function log(partial: Partial<BundleLog> & Pick<BundleLog, "name" | "owner">): BundleLog {
  return {
    contractAddress: "0x00000000000000000000000000000000000000aa",
    assetType: 1,
    tokenId: 1n,
    amount: 1n,
    blockNumber: 1,
    transactionIndex: 0,
    logIndex: 0,
    ...partial,
  }
}

const alice = "0x0000000000000000000000000000000000000001"
const bob = "0x0000000000000000000000000000000000000002"
const nft = "0x00000000000000000000000000000000000000aa"
const junk = "0x00000000000000000000000000000000000000bb"

const lists = bundleFromLogs([
  log({ name: "AssetAdded", owner: alice, contractAddress: nft, assetType: 1, tokenId: 7n, amount: 1n, logIndex: 1 }),
  log({ name: "AssetAdded", owner: bob, contractAddress: junk, assetType: 0, tokenId: 0n, amount: 1000n, logIndex: 0, blockNumber: 2 }),
  log({ name: "AssetRemoved", owner: alice, contractAddress: nft, tokenId: 7n, amount: 1n, logIndex: 2 }),
  log({
    name: "AssetAdded",
    owner: alice,
    contractAddress: junk,
    assetType: 0,
    tokenId: 0n,
    amount: 1n,
    logIndex: 3,
  }),
])

const aliceAssets = lists.get(alice) ?? []
const bobAssets = lists.get(bob) ?? []

if (aliceAssets.length !== 1 || aliceAssets[0].contractAddress !== junk || aliceAssets[0].amount !== 1n) {
  throw new Error(`alice bundle was not rebuilt from events: ${JSON.stringify(aliceAssets, (_, v) => typeof v === "bigint" ? v.toString() : v)}`)
}
if (bobAssets.length !== 1 || bobAssets[0].amount !== 1000n) {
  throw new Error("bob bundle was not rebuilt from events")
}

console.log("bundleFromLogs ok")
