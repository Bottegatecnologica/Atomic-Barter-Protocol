import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const escrow = await ethers.deployContract("TradeEscrow");
  await escrow.waitForDeployment();
  const testErc20 = await ethers.deployContract("MockERC20");
  await testErc20.waitForDeployment();
  const testErc721 = await ethers.deployContract("MockERC721");
  await testErc721.waitForDeployment();

  const addresses = {
    chainId: 11155111,
    escrow: await escrow.getAddress(),
    testErc20: await testErc20.getAddress(),
    testErc721: await testErc721.getAddress(),
  };

  const file = path.join(process.cwd(), "frontend", "src", "lib", "sepolia.addresses.json");
  fs.writeFileSync(file, `${JSON.stringify(addresses, null, 2)}\n`);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
