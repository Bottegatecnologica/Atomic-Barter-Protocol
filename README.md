#Introduction
Before any of us had money, we traded Pokémon cards. No prices, no order book. Just two kids and a phrase that held an entire economy: got it, got it, need it.

Two things were happening in that trade, and each became a protocol.

The card left one hand and arrived whole in the other, or it did not happen. No money in the middle, no agreed number, no clearing house. Just your card(/s) for my card(/s), both moving at once. You could not transfer half a Charizard, and neither of us had to admit what it was "worth."

Atomic Barter is that gesture, rebuilt onchain: intermediary-free, asset-to-asset exchange with no price denomination. A swap with no number in the middle. Either both sides move together or nothing does. It redesigns the trade from scratch, the way the playground already had it, before money taught us to put a figure on everything.

# Atomic Barter

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

- Built on **OpenZeppelin** (`IERC721`, `IERC20`, `ReentrancyGuard`).
- Pre-transfer checks for **ownership**, **allowance**, and **NFT approval for all**.
- **Reentrancy protection** on trade execution.
- Approvals reset automatically when either side changes their offered assets.

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

1. **Create** — Initiator calls `createTrade(counterparty)` and receives a unique `tradeId`.
2. **Fund (off-chain approval)** — Each party adds assets via `addNFT` or `addERC20`. Tokens must be approved to the escrow; NFTs require `setApprovalForAll`.
3. **Review** — Both parties inspect the full bundle on-chain (and in the UI).
4. **Approve** — Each party calls `approveTrade(tradeId)`. When the second approval arrives, `_executeTrade` runs automatically.
5. **Complete or cancel** — On success, assets are swapped; either party can still call `cancelTrade` while the trade is open.

### Smart contract model

```solidity
struct Trade {
    address initiator;
    address counterparty;
    bool initiatorApproved;
    bool counterpartyApproved;
    mapping(address => AssetList) assets;  // per-party asset lists
}
```

Each `Asset` records contract address, token ID (NFT), amount (ERC-20), and type (`ERC721` | `ERC20`).

---

## Tech Stack

| Area | Technologies |
|------|--------------|
| Smart contracts | Solidity 0.8.x, Hardhat, OpenZeppelin |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, shadcn/ui, Radix UI, Lucide icons |
| Tooling | ESLint, Yarn |

---

## Project Status

| Component | Status |
|-----------|--------|
| `TradeEscrow` smart contract | Core logic implemented |
| Hardhat project scaffold | Configured |
| React frontend shell | UI components started (`TradeInterface` scaffold) |
| Wallet & contract integration | Planned |
| Dedicated contract tests | Planned (repo still includes default Hardhat Lock boilerplate) |

This repository demonstrates the **contract-first** foundation of a P2P barter dApp. The frontend is set up for rapid iteration once wallet and ABI wiring are added.

---

## Design Decisions

- **Escrow over direct swap loops** — A single contract holds trade state and orchestrates transfers, keeping the UX linear (create → add → approve) instead of requiring users to craft complex multicall transactions.
- **Approval reset on asset change** — Prevents a party from approving an offer and silently having the counterparty swap in different assets afterward.
- **No custody before execution** — Assets remain in user wallets until execution; the contract uses standard `transferFrom` after allowances are set, avoiding unnecessary pre-deposits.

---

## Repository Structure

```
Atomic Barter/
├── contracts/
│   └── escrow-contract.sol    # TradeEscrow — main escrow logic
├── frontend/
│   └── src/
│       ├── App.tsx
│       └── components/
│           ├── trade-interface.tsx
│           └── ui/
├── ignition/                  # Hardhat Ignition deploy modules
├── test/                      # Hardhat tests
├── hardhat.config.ts
└── README.md
```

---

## Future Work

- Wire frontend to `TradeEscrow` via ethers/viem and a wallet provider (e.g. MetaMask, WalletConnect).
- Replace Lock boilerplate with `TradeEscrow` deployment and integration tests.
- Trade discovery: share `tradeId` via link or QR.
- Optional: support ERC-1155, fee routing, or L2 deployment profiles.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Yarn](https://yarnpkg.com/)
- A local Ethereum node or testnet RPC (for deployment and testing)

### Install dependencies

From the repository root:

```shell
yarn install
```

For the frontend:

```shell
cd frontend
yarn install
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

Deploy with Hardhat Ignition (update the module to target `TradeEscrow` when ready):

```shell
npx hardhat ignition deploy ./ignition/modules/Lock.ts --network localhost
```

### Frontend

Development server with hot reload:

```shell
cd frontend
yarn dev
```

Production build:

```shell
cd frontend
yarn build
yarn preview
```

Lint:

```shell
cd frontend
yarn lint
```

### Hardhat CLI

```shell
npx hardhat help
```

---

## License

MIT
