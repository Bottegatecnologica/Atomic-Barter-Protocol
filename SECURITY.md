# TradeEscrow security review

Self-review of `contracts/TradeEscrow.sol`, written in the form of an audit report. This is not an external audit. The findings below were in the previous version of the contract. Each one except the seal check was already fixed. O-01 is fixed in this source by the seal, and the Hardhat suite has a regression test for it. The contracts are for testnet use. Do not treat this file as an audit.

**Scope:** `TradeEscrow` — two-party atomic escrow for ERC-20 and ERC-721 bundles. Assets stay in the owners' wallets until both parties approve; settlement is a single transaction.

**Method:** manual review of the settlement loop, token assumptions, and storage layout. Foundry fuzz tests cover the invariant that a trade moves the whole bundle or moves nothing.

## Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| H-01 | `transferFrom` return value is ignored | High | Fixed |
| M-01 | Callback can cancel settlement after the first leg | Medium | Fixed |
| M-02 | Fee-on-transfer tokens settle a short payment | Medium | Fixed |
| M-03 | Unbounded asset lists can block execution | Medium | Fixed |
| M-04 | Approval is not bound to the bundle contents | Medium | Fixed |
| L-01 | A listed asset cannot be removed | Low | Fixed |
| L-02 | An approval never expires | Low | Fixed |
| I-01 | OpenZeppelin v4 import path | Info | Fixed |
| I-02 | Cancelling a trade left its asset arrays in storage | Info | Fixed |
| O-01 | A listed box can be emptied before settlement | High | Fixed |

## H-01 — `transferFrom` return value is ignored

**Severity:** High

The settlement loop called `IERC20.transferFrom` and ignored the bool. Two non-standard ERC-20 shapes fall out of that.

**Return `false` instead of reverting.** Some tokens, and any token written to look like them, signal failure by returning `false` and moving no balances. The call does not revert. The loop continued, transferred the other party's NFTs and tokens, and marked the trade executed. The counterparty kept the payment and received the other side.

Exploit:

1. Alice lists an NFT and approves the trade.
2. Bob lists an ERC-20 whose `transferFrom` returns `false` and does not debit him. He approves the trade.
3. Bob's approval runs settlement. Alice's NFT is transferred to Bob. Bob's `transferFrom` returns `false`. The old code did not check it.
4. The transaction succeeds. Alice no longer has the NFT. She received nothing.

USDT is the usual reason people reach for this class of bug, but mainnet USDT does not return `false`. Its `transferFrom` returns no data. Through the `IERC20` interface that missing word makes the ABI decoder revert, so a USDT leg could not settle at all. That is a broken payment, not a silent one. Both shapes are the same missing check.

**Fix:** pull ERC-20s with OpenZeppelin `SafeERC20.safeTransferFrom`. A `false` return reverts. Empty return data, which is what USDT produces, is treated as success. `test/TradeEscrow.ts` covers both tokens, and the false-return case asserts that Alice's NFT never moves.

## M-01 — Callback can cancel settlement after the first leg

**Severity:** Medium

`executed` was written after the transfers. `cancelTrade` was still available in the middle of the loop. A token that callbacks into the payer (ERC-777 `tokensToSend`, or a purpose-built token) lets that payer call `cancelTrade` once the other side has already been transferred.

`delete` on the trade struct clears `initiator` and `counterparty`. It does not clear a nested mapping, but the loop condition was `trade.assets[trade.counterparty]`. After the address was zeroed, the rest of the loop read an empty list and stopped. The transfers that had already happened stayed, because nothing reverted. The payer who owned the callback token could receive the other bundle and skip the rest of their own.

This needs a token the victim agreed to list. It is still a direct loss inside a trade both parties approved.

**Fix:** mark the trade executed, and clear the approvals, before any external transfer. `cancelTrade`, `addNFT`, `addERC20`, and `removeAsset` all refuse an executed trade. Every state-changing entrypoint also uses `nonReentrant`, so a callback cannot re-enter settlement. The regression test uses a counterparty contract whose token calls `cancelTrade` mid-transfer. The cancel does not land, and both sides still receive the full bundle.

## M-02 — Fee-on-transfer tokens settle a short payment

**Severity:** Medium

`transferFrom` can return success and still credit the recipient less than `amount` (a transfer fee, or a burn). The old loop treated that as a full payment. The trade completed. The receiver was underpaid by the fee, with no revert.

**Fix:** read the recipient balance before and after `safeTransferFrom`. If the increase is not exactly `amount`, settlement reverts with `FeeOnTransferNotSupported` and every earlier leg rolls back. Fee-on-transfer and rebasing tokens are unsupported on purpose. Users who want those tokens need a wrapper that delivers the exact amount.

## M-03 — Unbounded asset lists can block execution

**Severity:** Medium

Either party could push an unlimited number of assets. Settlement walks both lists in one transaction. Past a point the loop runs out of gas, the second approval always reverts, and that trade can no longer settle. The other party could still cancel, so funds were not stuck in the contract (the contract never held them). The grief was a trade that could not be completed, plus the gas already spent listing it.

**Fix:** `MAX_ASSETS_PER_PARTY` is 20. `addNFT` and `addERC20` revert with `TooManyAssets` above that.

## L-01 — A listed asset cannot be removed

**Severity:** Low

A wrong NFT or amount could only be undone by cancelling the whole trade and starting over. Combined with the missing cap, a party also had no way to shrink a list that was about to make settlement too expensive.

**Fix:** `removeAsset` drops one of the caller's items (swap-and-pop) and clears both approvals, same as adding an asset. Removing an item after the other party has approved forces both sides to review the bundle again.

## M-04 — Approval is not bound to the bundle contents

**Severity:** Medium

`approveTrade(tradeId)` approved whatever assets were stored at execution time. Approvals were cleared when the bundle changed, but the party who edited the bundle could approve the new one in the same block, ahead of a counterparty transaction that was already signed.

Exploit:

1. Alice and Bob list a real NFT against real tokens. Alice approves.
2. Bob broadcasts his approval.
3. Alice, with a higher gas price, removes her NFT, lists a worthless token, and approves that new bundle. Her transaction is ordered first.
4. Bob's approval then runs settlement. He pays the real tokens and receives the junk.

**Fix:** every add or remove increments `version` and clears both approvals. `approveTrade(tradeId, bundleVersion)` reverts with `StaleBundle` unless `bundleVersion` is the current one. Bob's pending transaction still carries the old version, so it cannot settle Alice's replacement. `test/TradeEscrow.ts` reproduces the sequence and checks that the NFT does not move.

## L-02 — An approval never expires

**Severity:** Low

A trade with one approval stayed open forever. The other party could approve months later, against prices and allowances that no longer matched what the first party meant.

**Fix:** `createTrade` takes a `deadline`. After that timestamp, adds, removes, and approvals revert with `TradeExpired`. `cancelTrade` still works, so the record can be cleared. A deadline that is not in the future is rejected at creation.

## I-01 — OpenZeppelin v4 import path

**Severity:** Informational

The contract imported `@openzeppelin/contracts/security/ReentrancyGuard.sol`. That path is OpenZeppelin Contracts v4. Current Contracts v5 moved the guard to `utils/ReentrancyGuard.sol`. The project also had no OpenZeppelin dependency in `package.json`, so the import could not resolve.

**Fix:** dependency is OpenZeppelin Contracts v5. The import is `utils/ReentrancyGuard.sol`.

## I-02 — Cancelling a trade left its asset arrays in storage

**Severity:** Informational

Asset lists lived in a mapping inside the `Trade` struct. Solidity does not clear nested mappings on `delete`, so `cancelTrade` zeroed the addresses and left the bundles in storage. Trade ids are unique, so the leftover arrays were not reusable by a later trade. They did waste storage.

**Fix:** asset arrays are stored in a separate mapping. `cancelTrade` deletes both parties' arrays and then the trade record. Settlement deletes the arrays after the transfers, which refunds the storage gas. `getTrade` on a cancelled id reverts with `TradeNotFound`; the cancelled state is not stored separately.

## O-01 — A listed box can be emptied before settlement

**Severity:** High

`TradeEscrow` records an NFT as a contract address and a token id. Assets stay in the owner's wallet until settlement, so the owner of a container can change what is inside after listing. `bundleVersion` increases when an asset is added to or removed from the trade. It does not increase when the inside of a listed asset changes.

Exploit:

1. Alice lists box #7 with 1,000 tokens inside. Bob lists his NFT and approves.
2. Alice withdraws the 1,000 tokens. The escrow still sees the same NFT.
3. Alice approves. Settlement would transfer the empty box to Bob.

If Bob is the one about to approve, Alice can put the withdrawal ahead of that transaction. Bridging the box does not pay the attacker: the box moves to the box contract, `transferFrom` fails, and the trade rolls back.

This is the same shape as an NFT that represents a Uniswap v3 position: the seller removes the liquidity just before the sale completes.

A second path shows up across contracts. Settlement can deliver some other token to Alice's smart wallet before her box moves. That token can call back into the wallet, and the wallet can unseal the box and empty it in the same transaction. Checking the seal only before the box moves is not enough if the callback happens later in the same settlement. The counter is checked again after every leg has moved.

**Fix:** containers implement `ISealable` (`contracts/ISealable.sol`, `pragma ^0.8.24`), the same interface as Schrödinger's Box. `addNFT` asks `supportsInterface` with `staticcall`. An NFT with no ERC-165 still lists. An NFT that reports the interface must already be sealed, and the escrow stores `sealState`. Before each such NFT is transferred, and again after all transfers, settlement reverts with `ContainerNotSealed` if it is open and `ContentChanged` if the counter moved.

Alice has to unseal to change the contents. That changes the counter. She then has to remove the box from the trade and list it again, which bumps `bundleVersion` and clears both approvals.

`test/TradeEscrow.ts` covers an unsealed box, a seal that is opened and closed, a token that unseals the box when it arrives at the seller during settlement, a box that is transferred away and back, a box that is bridged away, and a shadow that is listed because a shadow is always sealed.

The site shows the box contents and keeps Accept off when it can see that the seal no longer matches, or that a deposit or withdrawal landed after listing. That warning is not a substitute for the settlement check.

## Trust model

There is no owner, no pause, and no upgrade. A bad version is replaced by deploying a new address. The two parties are the only accounts that can list, approve, or cancel. Settlement moves the assets they already approved, or it reverts.

## Notes for integrators

- A container NFT is safe inside a trade only if it implements `ISealable` and the holder seals it before listing. Containers that do not, including an ERC-6551 account that does not expose `sealState` (or the older `state()` shape this escrow does not read), can still be emptied by their owner.
- Settlement uses ERC-721 `transferFrom`. That call does not ask the recipient to support ERC-721, so an NFT can be delivered to a contract that has no way to send it back.
- The list of tokens the site treats as known is stored in `localStorage`. It applies only in that browser.

## Reporting a vulnerability

Use Private vulnerability reporting on this GitHub repository (Settings, Security). Do not open a public issue for a problem that can move assets.

## Residual risk

These are accepted properties of the current design, not open findings.

- A token the user chose to list can still lie. If `balanceOf` increases by `amount` without a real economic transfer, or `ownerOf` reports the recipient after a no-op, the checks pass. The escrow cannot tell a dishonest token from a normal one. The site warns on contracts it does not know. The on-chain checks stop an honest fee, a `false` return, and a no-op that leaves balances unchanged.
- Container NFTs that do not implement `ISealable` can still be emptied after they are listed. The escrow does not try to guess which NFTs are containers.
- Listing an NFT requires `setApprovalForAll`. A one-token `approve` is not enough to list.
- Settlement uses ERC-721 `transferFrom`. An NFT can be delivered to a contract that cannot send it back.
- ETH is not an asset of this escrow. The contract does not receive ether and does not refund it, so there is no `address.transfer` path.
- The Sepolia escrow the site uses is `0xcEC6Ed6B834e0dF429A12F6a30fa0Dec14a9b5D5`, deployed 3 October 2026 from the source in this repository. It checks `ISealable` before listing and again after both sides have transferred. The explorer does not show that address as verified yet. The previous escrow `0x11dFdDDF9393F01d73c85c50245f5A979209B656` does not include the seal check.

## Tests

| Check | Where |
|-------|--------|
| `false` return rolls back the NFT leg | `test/TradeEscrow.ts` |
| Fee-on-transfer rolls back the NFT leg | `test/TradeEscrow.ts` |
| No-return-data ERC-20 settles the exact amount | `test/TradeEscrow.ts` |
| Cancel from a token callback does not break the swap | `test/TradeEscrow.ts` |
| Cap, removal, approval reset, one-sided offer | `test/TradeEscrow.ts` |
| Stale bundle version does not settle the replacement offer | `test/TradeEscrow.ts` |
| Deadline blocks a late approval; cancel still works | `test/TradeEscrow.ts` |
| O-01 unsealed box reverts with ContainerNotSealed | `test/TradeEscrow.ts` |
| O-01 seal opened and closed reverts with ContentChanged | `test/TradeEscrow.ts` |
| O-01 token arriving at the seller unseals the box | `test/TradeEscrow.ts` |
| Box transferred away and back still settles | `test/TradeEscrow.ts` |
| Bridged box rolls the trade back | `test/TradeEscrow.ts` |
| A shadow can be listed because it is always sealed | `test/TradeEscrow.ts` |
| Fuzz: exact amounts, or a `false` return moves nothing | `test/TradeEscrow.t.sol` |
| Invariant: token balances stay with the two parties and the escrow holds none | `test/TradeEscrow.t.sol` |
