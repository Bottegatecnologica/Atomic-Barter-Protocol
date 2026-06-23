import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
 
// Tests for TradeEscrow.
// Place in: test/TradeEscrow.ts
// Requires: @nomicfoundation/hardhat-toolbox, @openzeppelin/contracts,
// and contracts/mocks/Mocks.sol (MockERC20, MockERC721).
 
describe("TradeEscrow", () => {
  async function deployFixture() {
    const [deployer, alice, bob, mallory] = await ethers.getSigners();
 
    const Escrow = await ethers.getContractFactory("TradeEscrow");
    const escrow = await Escrow.deploy();
    await escrow.waitForDeployment();
    const escrowAddr = await escrow.getAddress();
 
    const ERC20 = await ethers.getContractFactory("MockERC20");
    const token = await ERC20.deploy("Token A", "TKA");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
 
    const ERC721 = await ethers.getContractFactory("MockERC721");
    const nft = await ERC721.deploy("NFT A", "NFA");
    await nft.waitForDeployment();
    const nftAddr = await nft.getAddress();
 
    return {
      escrow, escrowAddr,
      token, tokenAddr,
      nft, nftAddr,
      deployer, alice, bob, mallory,
    };
  }
 
  // createTrade returns the tradeId, but as a state-changing tx we read it from the event.
  async function createTrade(escrow: any, initiator: any, counterparty: any): Promise<string> {
    const tx = await escrow.connect(initiator).createTrade(counterparty.address);
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = escrow.interface.parseLog(log);
        if (parsed?.name === "TradeCreated") return parsed.args.tradeId as string;
      } catch {
        // not one of our events, skip
      }
    }
    throw new Error("TradeCreated event not found");
  }
 
  describe("createTrade", () => {
    it("emits TradeCreated and stores the parties", async () => {
      const { escrow, alice, bob } = await loadFixture(deployFixture);
 
      await expect(escrow.connect(alice).createTrade(bob.address))
        .to.emit(escrow, "TradeCreated");
 
      const tradeId = await createTrade(escrow, alice, bob);
      const t = await escrow.trades(tradeId);
      expect(t.initiator).to.equal(alice.address);
      expect(t.counterparty).to.equal(bob.address);
      expect(t.executed).to.equal(false);
    });
 
    it("reverts on the zero address", async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(alice).createTrade(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid counterparty");
    });
 
    it("reverts when trading with yourself", async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(alice).createTrade(alice.address)
      ).to.be.revertedWith("Cannot trade with yourself");
    });
 
    it("creates distinct ids for repeated trades between the same parties", async () => {
      const { escrow, alice, bob } = await loadFixture(deployFixture);
      const id1 = await createTrade(escrow, alice, bob);
      const id2 = await createTrade(escrow, alice, bob);
      expect(id1).to.not.equal(id2);
    });
  });
 
  describe("adding assets", () => {
    it("lets a party add an owned, approved NFT and emits AssetAdded", async () => {
      const { escrow, escrowAddr, nft, nftAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await nft.mint(alice.address, 1);
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
 
      await expect(escrow.connect(alice).addNFT(tradeId, nftAddr, 1))
        .to.emit(escrow, "AssetAdded")
        .withArgs(tradeId, alice.address, nftAddr, 1, 1);
    });
 
    it("reverts when the caller does not own the NFT", async () => {
      const { escrow, escrowAddr, nft, nftAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await nft.mint(bob.address, 1); // owned by bob, not alice
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
 
      await expect(
        escrow.connect(alice).addNFT(tradeId, nftAddr, 1)
      ).to.be.revertedWith("Not owner of NFT");
    });
 
    it("reverts when the NFT is not approved for the escrow", async () => {
      const { escrow, nft, nftAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await nft.mint(alice.address, 1); // no setApprovalForAll
 
      await expect(
        escrow.connect(alice).addNFT(tradeId, nftAddr, 1)
      ).to.be.revertedWith("NFT not approved");
    });
 
    it("reverts when a non-party tries to add an asset", async () => {
      const { escrow, escrowAddr, nft, nftAddr, alice, bob, mallory } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await nft.mint(mallory.address, 1);
      await nft.connect(mallory).setApprovalForAll(escrowAddr, true);
 
      await expect(
        escrow.connect(mallory).addNFT(tradeId, nftAddr, 1)
      ).to.be.revertedWith("Not authorized");
    });
 
    it("requires balance and allowance to add ERC20", async () => {
      const { escrow, escrowAddr, token, tokenAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      // no balance yet
      await expect(
        escrow.connect(alice).addERC20(tradeId, tokenAddr, 1000)
      ).to.be.revertedWith("Insufficient balance");
 
      // balance but no allowance
      await token.mint(alice.address, 1000);
      await expect(
        escrow.connect(alice).addERC20(tradeId, tokenAddr, 1000)
      ).to.be.revertedWith("Token not approved");
 
      // balance + allowance -> ok
      await token.connect(alice).approve(escrowAddr, 1000);
      await expect(escrow.connect(alice).addERC20(tradeId, tokenAddr, 1000))
        .to.emit(escrow, "AssetAdded")
        .withArgs(tradeId, alice.address, tokenAddr, 0, 1000);
    });
 
    it("resets prior approvals when a new asset is added", async () => {
      const { escrow, escrowAddr, token, tokenAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await escrow.connect(alice).approveTrade(tradeId);
      let t = await escrow.trades(tradeId);
      expect(t.initiatorApproved).to.equal(true);
 
      await token.mint(alice.address, 500);
      await token.connect(alice).approve(escrowAddr, 500);
      await escrow.connect(alice).addERC20(tradeId, tokenAddr, 500);
 
      t = await escrow.trades(tradeId);
      expect(t.initiatorApproved).to.equal(false);
    });
  });
 
  describe("approval and atomic execution", () => {
    it("swaps a multi-asset bundle when both parties approve", async () => {
      const { escrow, escrowAddr, token, tokenAddr, nft, nftAddr, alice, bob } =
        await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      // Alice offers NFT #1
      await nft.mint(alice.address, 1);
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
      await escrow.connect(alice).addNFT(tradeId, nftAddr, 1);
 
      // Bob offers 1000 TKA
      await token.mint(bob.address, 1000);
      await token.connect(bob).approve(escrowAddr, 1000);
      await escrow.connect(bob).addERC20(tradeId, tokenAddr, 1000);
 
      await escrow.connect(alice).approveTrade(tradeId);
      await expect(escrow.connect(bob).approveTrade(tradeId))
        .to.emit(escrow, "TradeCompleted")
        .withArgs(tradeId);
 
      // Assets crossed over.
      expect(await nft.ownerOf(1)).to.equal(bob.address);
      expect(await token.balanceOf(alice.address)).to.equal(1000n);
      expect(await token.balanceOf(bob.address)).to.equal(0n);
 
      const t = await escrow.trades(tradeId);
      expect(t.executed).to.equal(true);
    });
 
    it("does not execute until the second approval arrives", async () => {
      const { escrow, escrowAddr, nft, nftAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await nft.mint(alice.address, 1);
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
      await escrow.connect(alice).addNFT(tradeId, nftAddr, 1);
 
      await escrow.connect(alice).approveTrade(tradeId);
 
      const t = await escrow.trades(tradeId);
      expect(t.executed).to.equal(false);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });
 
    it("reverts approval from a non-party", async () => {
      const { escrow, alice, bob, mallory } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
      await expect(
        escrow.connect(mallory).approveTrade(tradeId)
      ).to.be.revertedWith("Not authorized");
    });
 
    it("reverts approval after the trade is executed", async () => {
      const { escrow, escrowAddr, token, tokenAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await token.mint(bob.address, 100);
      await token.connect(bob).approve(escrowAddr, 100);
      await escrow.connect(bob).addERC20(tradeId, tokenAddr, 100);
 
      await escrow.connect(alice).approveTrade(tradeId);
      await escrow.connect(bob).approveTrade(tradeId); // executes
 
      await expect(
        escrow.connect(alice).approveTrade(tradeId)
      ).to.be.revertedWith("Trade already completed");
    });
  });
 
  describe("atomicity", () => {
    it("moves nothing if one transfer fails (allowance revoked before execution)", async () => {
      const { escrow, escrowAddr, token, tokenAddr, nft, nftAddr, alice, bob } =
        await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      // Alice offers NFT #1
      await nft.mint(alice.address, 1);
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
      await escrow.connect(alice).addNFT(tradeId, nftAddr, 1);
 
      // Bob offers 1000 TKA, then revokes the allowance after adding.
      await token.mint(bob.address, 1000);
      await token.connect(bob).approve(escrowAddr, 1000);
      await escrow.connect(bob).addERC20(tradeId, tokenAddr, 1000);
      await token.connect(bob).approve(escrowAddr, 0); // sabotage
 
      await escrow.connect(alice).approveTrade(tradeId);
 
      // Second approval triggers execution, which must revert on Bob's transfer.
      await expect(escrow.connect(bob).approveTrade(tradeId)).to.be.reverted;
 
      // Nothing moved: trade is atomic.
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await token.balanceOf(bob.address)).to.equal(1000n);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
 
      const t = await escrow.trades(tradeId);
      expect(t.executed).to.equal(false);
    });
  });
 
  describe("cancelTrade", () => {
    it("lets either party cancel and emits TradeCancelled", async () => {
      const { escrow, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await expect(escrow.connect(bob).cancelTrade(tradeId))
        .to.emit(escrow, "TradeCancelled")
        .withArgs(tradeId);
 
      const t = await escrow.trades(tradeId);
      expect(t.initiator).to.equal(ethers.ZeroAddress);
    });
 
    it("makes the trade unusable after cancellation", async () => {
      const { escrow, escrowAddr, nft, nftAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await escrow.connect(alice).cancelTrade(tradeId);
 
      await nft.mint(alice.address, 1);
      await nft.connect(alice).setApprovalForAll(escrowAddr, true);
      await expect(
        escrow.connect(alice).addNFT(tradeId, nftAddr, 1)
      ).to.be.revertedWith("Trade not found");
    });
 
    it("reverts cancellation from a non-party", async () => {
      const { escrow, alice, bob, mallory } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
      await expect(
        escrow.connect(mallory).cancelTrade(tradeId)
      ).to.be.revertedWith("Not authorized");
    });
 
    it("reverts cancellation after execution", async () => {
      const { escrow, escrowAddr, token, tokenAddr, alice, bob } = await loadFixture(deployFixture);
      const tradeId = await createTrade(escrow, alice, bob);
 
      await token.mint(bob.address, 100);
      await token.connect(bob).approve(escrowAddr, 100);
      await escrow.connect(bob).addERC20(tradeId, tokenAddr, 100);
      await escrow.connect(alice).approveTrade(tradeId);
      await escrow.connect(bob).approveTrade(tradeId); // executes
 
      await expect(
        escrow.connect(alice).cancelTrade(tradeId)
      ).to.be.revertedWith("Trade already completed");
    });
  });
});
