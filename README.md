# Introduction

Before any of us had money, we traded Pokémon cards. No prices, no order book. Just two kids and a phrase that held an entire economy: got it, got it, need it.

Two things were happening in that trade, and each became a protocol.

The card left one hand and arrived whole in the other, or it did not happen. No money in the middle, no agreed number, no clearing house. Just your card(/s) for my card(/s), both moving at once. You could not transfer half a Charizard, and neither of us had to admit what it was "worth."

Atomic Barter is that gesture, rebuilt onchain: intermediary-free, asset-to-asset exchange with no price denomination. A swap with no number in the middle. Either both sides move together or nothing does. It redesigns the trade from scratch, the way the playground already had it, before money taught us to put a figure on everything.

## Atomic Barter

**Trustless peer-to-peer swaps for NFTs and ERC-20 tokens on Ethereum. (Yes it can also allow for ERC20)**

Atomic Barter is a decentralized trading application that lets two parties exchange digital assets atomically — either both sides receive what they agreed on, or nothing moves. An on-chain escrow smart contract coordinates the trade, while a React frontend provides a wallet-connected interface for proposing, reviewing, and approving swaps.

---

## Overview

Traditional NFT and token trades often rely on informal agreements, centralized marketplaces, or multi-step transfers that expose users to counterparty risk. Atomic Barter addresses this with a simple escrow model: both parties list what they are offering, approve the final bundle, and the contract executes all transfers in a single atomic transaction.

The project is split into two layers:

| Layer | Role |
|-------|------|
| **Smart contract** (`TradeEscrow`) | Stores trade state, validates ownership and approvals, executes swaps |
| **Frontend** | Wallet UI for creating trades, adding assets, and signing approvals |

---

## Key Features

### On-chain escrow

- **Two-party trades** — An initiator opens a trade with a counterparty address; both must participate.
- **Multi-asset bundles** — Each side can add multiple ERC-721 NFTs and/or ERC-20 tokens to the same trade.
- **Mutual approval** — Transfers run only after both parties explicitly approve the current asset list.
- **Atomic settlement** — All assets move in one internal execution; partial or one-sided delivery is not possible.
- **Cancellation** — Either participant can cancel an open trade before completion.

### Safety & standards

- Built on **OpenZeppelin** (`IERC721`, `IERC20`, `SafeERC20`, `ReentrancyGuard`).
- ERC-20 pulls use `safeTransferFrom`. A `false` return reverts the whole trade. The recipient balance must increase by the exact amount, so a fee-on-transfer token cannot settle short.
- Pre-transfer checks for **ownership**, **allowance** (including amounts already listed), and **NFT approval for all**.
- Each party can list at most 20 assets and can remove one before settlement.
- **Reentrancy protection** on settlement and on bundle edits. The trade is marked executed before any transfer.
- An approval names the bundle version the caller reviewed. Editing the bundle increments that version, so a transaction already in the mempool cannot settle the new offer.
- Each trade has a deadline. After it, the bundle can no longer change or be approved. Either party can still cancel.

The bugs this replaced, and how each one was exploited, are written up in [SECURITY.md](SECURITY.md).

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐
│   React UI      │  tx     │   TradeEscrow.sol    │
│  (Vite + TS)    │ ──────► │   (Ethereum L1/L2)   │
│                 │ ◄────── │                      │
│  Wallet connect │ events  │  createTrade()       │
│  Trade flow     │         │  addNFT() / addERC20 │
└─────────────────┘         │  approveTrade()      │
                            │  cancelTrade()       │
                            └──────────────────────┘
```

### Trade lifecycle

1. **Create** — Initiator calls `createTrade(counterparty, deadline)` and receives a unique `tradeId`.
2. **Fund (off-chain approval)** — Each party adds assets via `addNFT` or `addERC20`. Tokens must be approved to the escrow. NFTs require `setApprovalForAll`; a one-token `approve` is not enough to list.
3. **Review** — Both parties inspect the full bundle on-chain (and in the UI), including the token contracts and the counterparty address. Read `version` from `getTrade`.
4. **Approve** — Each party calls `approveTrade(tradeId, version)` with the version they reviewed. When the second approval of that same version arrives, `_executeTrade` runs automatically.
5. **Complete or cancel** — On success, assets are swapped. Either party can call `cancelTrade` while the trade is open, including after the deadline.

### Smart contract model

```solidity
struct Trade {
    address initiator;
    address counterparty;
    bool initiatorApproved;
    bool counterpartyApproved;
    bool executed;
    uint256 deadline;
    uint256 version;
}
```

Each party's assets live in a separate array, not inside `Trade`. Solidity does not clear a nested mapping on `delete`, and cancel has to drop the bundles. Each `Asset` records contract address, token ID (NFT), amount (ERC-20), and type (`ERC721` | `ERC20`).

---

## Tech Stack

| Area | Technologies |
|------|--------------|
| Smart contracts | Solidity 0.8.x, Hardhat, OpenZeppelin |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, shadcn/ui, Radix UI, Lucide icons |
| Tooling | ESLint, npm, Hardhat, Foundry |

---

## Project Status

| Component | Status |
|-----------|--------|
| `TradeEscrow` smart contract | Core logic implemented, settlement hardened |
| Hardhat tests | Cover settlement, non-standard ERC-20s, and the reentrancy case |
| Foundry fuzz / invariant tests | All-or-nothing swap, escrow never custodies tokens |
| React trade screen | Calls the current contract, warns on unknown tokens, rebuilds settled bundles from events |
| Wallet & contract integration | Wallet connect, create, add, approve, and cancel |
| Sepolia deployment | TradeEscrow and the open-mint test tokens are deployed. Source is not verified on the explorer yet |

The trade screen calls `createTrade(counterparty, deadline)` and `approveTrade(tradeId, version)`. A contract that is not on the local allowlist has to be explicitly accepted before it can be listed. After settlement the screen rebuilds the bundle from `AssetAdded` and `AssetRemoved`, because the contract deletes those arrays.

---

## Design Decisions

- **Escrow over direct swap loops** — A single contract holds trade state and orchestrates transfers, keeping the UX linear (create → add → approve) instead of requiring users to craft complex multicall transactions.
- **Approval is bound to a bundle version** — `approveTrade` takes the version the caller reviewed. Any add or remove increments it and clears both approvals, so a pending transaction cannot settle a bundle it did not sign.
- **A deadline on every trade** — The initiator sets when the offer stops being approvable. A forgotten approval cannot be settled months later.
- **The contract cannot vet token contracts** — `ownerOf` and `balanceOf` are whatever the token says. A hostile token can lie and still pass the checks. The interface that lists a trade has to warn on unknown contracts, or restrict them to an allowlist. Settlement also uses ERC-721 `transferFrom`, which will deliver an NFT to a contract that does not know how to hold one. Review the counterparty before approving.
- **No custody before execution** — Assets remain in user wallets until execution. The contract pulls them with `safeTransferFrom` only after both allowances are set.
- **Exact delivery** — An ERC-20 leg is accepted only when the recipient's balance increases by the listed amount. Short payments revert the entire swap.
- **Bounded, editable bundles** — A party can remove a listed asset. Neither side can grow the execution loop past 20 items.

---

## Repository Structure

```
Atomic Barter/
├── contracts/
│   ├── TradeEscrow.sol        # TradeEscrow — main escrow logic
│   └── mocks/Mocks.sol        # Tokens used by the tests
├── frontend/
│   └── src/
│       ├── App.tsx
│       └── components/
│           ├── trade-interface.tsx
│           └── ui/
├── ignition/modules/TradeEscrow.ts
├── test/                      # Hardhat tests and Foundry fuzz tests
├── hardhat.config.ts
├── foundry.toml
├── SECURITY.md                # Self-review of the issues fixed in TradeEscrow
└── README.md
```

---

## Future Work

- Wire frontend to `TradeEscrow` via ethers/viem and a wallet provider (e.g. MetaMask, WalletConnect).
- Publish a verified testnet deployment and record the address in Deployments.
- Trade discovery: share `tradeId` via link or QR.
- Optional: support ERC-1155 or an L2 deployment profile. Fee-on-transfer tokens stay unsupported.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A local Ethereum node or testnet RPC (for deployment)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) if you want the fuzz tests

### Install dependencies

From the repository root:

```shell
npm install
```

For the frontend:

```shell
cd frontend
npm install
```

### Smart contracts

Compile and run tests:

```shell
npx hardhat compile
npx hardhat test
```

Optional — gas report:

```shell
REPORT_GAS=true npx hardhat test
```

Start a local Hardhat node:

```shell
npx hardhat node
```

Fuzz tests (Foundry). Install `forge-std` once, from the repository root:

```shell
forge install foundry-rs/forge-std
forge test
```

Deploy with Hardhat Ignition:

```shell
npx hardhat ignition deploy ./ignition/modules/TradeEscrow.ts --network localhost
```

### Deployments

Sepolia deployment. The test ERC-20 and test NFT have an open `mint`, so the frontend can create trial assets. They have no value. Source is not verified on the explorer yet.

| Network | Contract | Address | Explorer |
|---------|----------|---------|----------|
| Sepolia | TradeEscrow | `0x11dFdDDF9393F01d73c85c50245f5A979209B656` | [view](https://sepolia.etherscan.io/address/0x11dFdDDF9393F01d73c85c50245f5A979209B656) |
| Sepolia | Test ERC-20 | `0xf0977881b567A4bb4B10eF52f1D088B36E120b24` | [view](https://sepolia.etherscan.io/address/0xf0977881b567A4bb4B10eF52f1D088B36E120b24) |
| Sepolia | Test NFT | `0x587D76448cC1304bdf2436e92A1cB1b369b8Ad8f` | [view](https://sepolia.etherscan.io/address/0x587D76448cC1304bdf2436e92A1cB1b369b8Ad8f) |

### Frontend

Development server with hot reload:

```shell
cd frontend
npm run dev
```

Production build:

```shell
cd frontend
npm run build
npm run preview
```

Lint:

```shell
cd frontend
npm run lint
```

### Hardhat CLI

```shell
npx hardhat help
```

---

## License

MIT
