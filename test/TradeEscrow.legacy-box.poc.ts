import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

describe("Audit PoC: legacy ISealable box", function () {
  it("rejects a box from a pre-contentHash deployment", async function () {
    const [alice, bob] = await hre.ethers.getSigners();
    const escrow = await (await hre.ethers.getContractFactory("TradeEscrow")).deploy();
    const token = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
    const nft = await (await hre.ethers.getContractFactory("MockERC721")).deploy();
    const box = await (await hre.ethers.getContractFactory("LegacySchrodingerBox")).deploy(
      alice.address,
      10002,
      alice.address
    );
    const escrowAddress = await escrow.getAddress();
    const boxAddress = await box.getAddress();
    const tokenAddress = await token.getAddress();

    await token.mint(alice.address, 1000n);
    await nft.mint(bob.address, 2);
    const id = await box.connect(alice).mintBox.staticCall();
    await box.connect(alice).mintBox();
    await token.connect(alice).approve(boxAddress, 1000n);
    await box.connect(alice).depositERC20(id, tokenAddress, 1000n);
    await box.connect(alice).seal(id);
    expect(await box.isSealed(id)).to.equal(true);

    await box.connect(alice).setApprovalForAll(escrowAddress, true);
    await nft.connect(bob).setApprovalForAll(escrowAddress, true);
    const deadline = (await time.latest()) + 86400;
    const receipt = await (await escrow.connect(alice).createTrade(bob.address, deadline)).wait();
    const tradeId = escrow.interface.parseLog(receipt!.logs[0])!.args.tradeId as string;

    await expect(escrow.connect(alice).addNFT(tradeId, boxAddress, id)).to.be.revertedWithCustomError(
      escrow,
      "LegacyContainer"
    );
    expect(await box.ownerOf(id)).to.equal(alice.address);
    expect(await box.getERC20Balance(id, tokenAddress)).to.equal(1000n);
    expect(await nft.ownerOf(2)).to.equal(bob.address);
  });
});
