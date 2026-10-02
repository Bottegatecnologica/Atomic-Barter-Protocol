// Deploys TradeEscrow. The contract has no constructor arguments.
// https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const TradeEscrowModule = buildModule("TradeEscrowModule", (m) => {
  const tradeEscrow = m.contract("TradeEscrow");

  return { tradeEscrow };
});

export default TradeEscrowModule;
