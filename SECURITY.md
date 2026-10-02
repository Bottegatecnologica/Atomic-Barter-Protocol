# TradeEscrow security review

Self-review of `contracts/TradeEscrow.sol`, written in the form of an audit report. This is not a third-party audit. The findings below were in the previous version of the contract. Each one is fixed in the current source, and the Hardhat suite has a regression test for it.

**Scope:** `TradeEscrow` — two-party atomic escrow for ERC-20 and ERC-721 bundles. Assets stay in the owners' wallets until both parties approve; settlement is a single transaction.

**Method:** manual review of the settlement loop, token assumptions, and storage layout. Foundry fuzz tests cover the invariant that a trade moves the whole bundle or moves nothing.

## Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| H-01 | `transferFrom` return value is ignored | High | Fixed |
| M-01 | Callback can cancel settlement after the first leg | Medium | Fixed |
| M-02 | Fee-on-transfer tokens settle a short payment | Medium | Fixed |
| M-03 | Unbounded asset lists can block execution | Medium | Fixed |
| L-01 | A listed asset cannot be removed | Low | Fixed |
| I-01 | OpenZeppelin v4 import path | Info | Fixed |
| I-02 | Cancelling a trade left its asset arrays in storage | Info | Fixed |

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

## I-01 — OpenZeppelin v4 import path

**Severity:** Informational

The contract imported `@openzeppelin/contracts/security/ReentrancyGuard.sol`. That path is OpenZeppelin Contracts v4. Current Contracts v5 moved the guard to `utils/ReentrancyGuard.sol`. The project also had no OpenZeppelin dependency in `package.json`, so the import could not resolve.

**Fix:** dependency is OpenZeppelin Contracts v5. The import is `utils/ReentrancyGuard.sol`.

## I-02 — Cancelling a trade left its asset arrays in storage

**Severity:** Informational

Asset lists lived in a mapping inside the `Trade` struct. Solidity does not clear nested mappings on `delete`, so `cancelTrade` zeroed the addresses and left the bundles in storage. Trade ids are unique, so the leftover arrays were not reusable by a later trade. They did waste storage.

**Fix:** asset arrays are stored in a separate mapping. `cancelTrade` deletes both parties' arrays and then the trade record.

## Residual risk

These are accepted properties of the current design, not open findings.

- A token the user chose to list can still lie. If `balanceOf` increases by `amount` without a real economic transfer, the balance check passes. The escrow cannot tell a dishonest token from a normal one. The check does stop an honest fee, a `false` return, and a no-op that leaves balances unchanged.
- The same limit applies to NFTs. After `transferFrom` the contract requires `ownerOf(tokenId) == recipient`. An NFT that lies about its owner gets through.
- Listing an NFT requires `setApprovalForAll`. A one-token `approve` is not enough to list. Settlement itself uses `transferFrom`, which accepts either approval.
- ETH is not an asset of this escrow. The contract does not receive ether and does not refund it, so there is no `address.transfer` path.
- There is no admin, pause, or upgrade. A bad version is replaced by deploying a new address.
- No deployment in this repository is verified on an explorer. Addresses will be added to the README when one is.

## Tests

| Check | Where |
|-------|--------|
| `false` return rolls back the NFT leg | `test/TradeEscrow.ts` |
| Fee-on-transfer rolls back the NFT leg | `test/TradeEscrow.ts` |
| No-return-data ERC-20 settles the exact amount | `test/TradeEscrow.ts` |
| Cancel from a token callback does not break the swap | `test/TradeEscrow.ts` |
| Cap, removal, approval reset, one-sided offer | `test/TradeEscrow.ts` |
| Fuzz: exact amounts, or a `false` return moves nothing | `test/TradeEscrow.t.sol` |
| Invariant: token balances stay with the two parties and the escrow holds none | `test/TradeEscrow.t.sol` |
