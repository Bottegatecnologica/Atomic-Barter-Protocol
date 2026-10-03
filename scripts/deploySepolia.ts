import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const escrow = await ethers.deployContract("TradeEscrow");
  await escrow.waitForDeployment();

  const file = path.join(process.cwd(), "frontend", "src", "lib", "sepolia.addresses.json");
  const previous = JSON.parse(fs.readFileSync(file, "utf8"));
  const addresses = {
    chainId: 11155111,
    escrow: await escrow.getAddress(),
    testErc20: previous.testErc20,
    testErc721: previous.testErc721,
  };

  fs.writeFileSync(file, `${JSON.stringify(addresses, null, 2)}\n`);
  console.log(`deployer ${deployer.address}`);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
