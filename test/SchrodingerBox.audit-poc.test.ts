import { expect } from "chai";
import hre from "hardhat";

describe("Audit PoC", function () {
  async function deploy() {
    const [owner, alice] = await hre.ethers.getSigners();
    const relayer = await (await hre.ethers.getContractFactory("MockRelayer")).deploy();
    const box = await (await hre.ethers.getContractFactory("SchrodingerBox")).deploy(
      await relayer.getAddress(),
      10002,
      owner.address
    );
    return { box, alice };
  }

  it("rejects depositing a box into itself", async function () {
    const { box, alice } = await deploy();
    const id = await box.connect(alice).mintBox.staticCall();
    await box.connect(alice).mintBox();
    await box.connect(alice).approve(await box.getAddress(), id);
    await expect(
      box.connect(alice).depositNFT(id, await box.getAddress(), id)
    ).to.be.revertedWithCustomError(box, "SelfDeposit");
  });

  it("keeps an inner box untouched while it sits inside an outer box", async function () {
    const { box, alice } = await deploy();
    const inner = await box.connect(alice).mintBox.staticCall();
    await box.connect(alice).mintBox();
    const outer = await box.connect(alice).mintBox.staticCall();
    await box.connect(alice).mintBox();
    await box.connect(alice).approve(await box.getAddress(), inner);
    await box.connect(alice).depositNFT(outer, await box.getAddress(), inner);
    await box.connect(alice).seal(outer);
    await expect(box.connect(alice).unseal(inner)).to.be.revertedWithCustomError(box, "NotBoxOwner");
    await expect(box.connect(alice).withdrawERC20(inner, alice.address)).to.be.revertedWithCustomError(box, "NotBoxOwner");
    expect(await box.isSealed(inner)).to.equal(false);
  });
});
