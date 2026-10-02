import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

async function deployFixture() {
  const [alice, bob, carol] = await hre.ethers.getSigners();

  const escrow = await (await hre.ethers.getContractFactory("TradeEscrow")).deploy();
  const token = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
  const nft = await (await hre.ethers.getContractFactory("MockERC721")).deploy();

  const aliceTokens = hre.ethers.parseEther("1000");
  const bobTokens = hre.ethers.parseEther("1000");
  await token.mint(alice.address, aliceTokens);
  await token.mint(bob.address, bobTokens);
  await nft.mint(alice.address, 1);
  await nft.mint(bob.address, 2);

  return { escrow, token, nft, alice, bob, carol, aliceTokens, bobTokens };
}

async function openDeadline() {
  return (await time.latest()) + 7 * 24 * 60 * 60;
}

async function approveStandardAssets({
  escrow,
  token,
  nft,
  alice,
  bob,
}: Awaited<ReturnType<typeof deployFixture>>) {
  const escrowAddress = await escrow.getAddress();
  await token.connect(alice).approve(escrowAddress, hre.ethers.MaxUint256);
  await token.connect(bob).approve(escrowAddress, hre.ethers.MaxUint256);
  await nft.connect(alice).setApprovalForAll(escrowAddress, true);
  await nft.connect(bob).setApprovalForAll(escrowAddress, true);
}

async function bundleVersion(escrow: { getTrade: (id: string) => Promise<{ version: bigint }> }, tradeId: string) {
  return (await escrow.getTrade(tradeId)).version;
}

async function readTradeId(escrow: any, tx: any): Promise<string> {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "TradeCreated") return parsed.args.tradeId;
    } catch {
      // Log from another contract.
    }
  }
  throw new Error("TradeCreated was not emitted");
}

describe("TradeEscrow", function () {
  describe("createTrade", function () {
    it("opens a trade between two distinct parties", async function () {
      const { escrow, alice, bob } = await loadFixture(deployFixture);

      const tx = await escrow.connect(alice).createTrade(bob.address, await openDeadline());
      await expect(tx).to.emit(escrow, "TradeCreated");
      const tradeId = await readTradeId(escrow, tx);

      const trade = await escrow.getTrade(tradeId);
      expect(trade.initiator).to.equal(alice.address);
      expect(trade.counterparty).to.equal(bob.address);
      expect(trade.executed).to.equal(false);
      expect(trade.initiatorAssetCount).to.equal(0);
      expect(trade.counterpartyAssetCount).to.equal(0);
    });

    it("rejects a missing counterparty and a self-trade", async function () {
      const { escrow, alice } = await loadFixture(deployFixture);

      await expect(escrow.connect(alice).createTrade(hre.ethers.ZeroAddress, await openDeadline()))
        .to.be.revertedWithCustomError(escrow, "InvalidCounterparty");
      await expect(escrow.connect(alice).createTrade(alice.address, await openDeadline()))
        .to.be.revertedWithCustomError(escrow, "SelfTrade");
    });
  });

  describe("listing assets", function () {
    it("requires ownership, approval, and a positive funded balance", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, token, nft, alice, bob, carol } = ctx;
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));

      await expect(escrow.connect(carol).addNFT(tradeId, await nft.getAddress(), 1))
        .to.be.revertedWithCustomError(escrow, "NotParticipant");
      await expect(escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1))
        .to.be.revertedWithCustomError(escrow, "NftNotApproved");
      await expect(escrow.connect(alice).addERC20(tradeId, await token.getAddress(), 0))
        .to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.connect(alice).addERC20(tradeId, await token.getAddress(), hre.ethers.parseEther("1001")))
        .to.be.revertedWithCustomError(escrow, "InsufficientBalance");

      await approveStandardAssets(ctx);
      await expect(escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 2))
        .to.be.revertedWithCustomError(escrow, "NotNftOwner");
    });

    it("rejects a duplicate NFT and sums ERC-20 allowances", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, token, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      const tokenAddress = await token.getAddress();
      const nftAddress = await nft.getAddress();

      await escrow.connect(alice).addNFT(tradeId, nftAddress, 1);
      await expect(escrow.connect(alice).addNFT(tradeId, nftAddress, 1))
        .to.be.revertedWithCustomError(escrow, "DuplicateNft");

      const escrowAddress = await escrow.getAddress();
      await token.connect(alice).approve(escrowAddress, 150);
      await escrow.connect(alice).addERC20(tradeId, tokenAddress, 100);
      await expect(escrow.connect(alice).addERC20(tradeId, tokenAddress, 60))
        .to.be.revertedWithCustomError(escrow, "InsufficientAllowance");
    });

    it("caps each side and allows an asset to be removed", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      const nftAddress = await nft.getAddress();
      const max = Number(await escrow.MAX_ASSETS_PER_PARTY());

      for (let tokenId = 10; tokenId < 10 + max; tokenId++) {
        await nft.mint(alice.address, tokenId);
        await escrow.connect(alice).addNFT(tradeId, nftAddress, tokenId);
      }

      await nft.mint(alice.address, 10 + max);
      await expect(escrow.connect(alice).addNFT(tradeId, nftAddress, 10 + max))
        .to.be.revertedWithCustomError(escrow, "TooManyAssets");

      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));
      expect((await escrow.getTrade(tradeId)).initiatorApproved).to.equal(true);

      await expect(escrow.connect(alice).removeAsset(tradeId, max))
        .to.be.revertedWithCustomError(escrow, "InvalidIndex");

      await expect(escrow.connect(alice).removeAsset(tradeId, 0))
        .to.emit(escrow, "AssetRemoved");

      const trade = await escrow.getTrade(tradeId);
      expect(trade.initiatorApproved).to.equal(false);
      expect(trade.initiatorAssetCount).to.equal(max - 1);

      const listed = await escrow.getAssets(tradeId, alice.address);
      expect(listed[0].tokenId).to.equal(10 + max - 1);
    });

    it("resets both approvals when the bundle changes", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, token, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));

      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);
      await escrow.connect(bob).addERC20(tradeId, await token.getAddress(), 1);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));
      await escrow.connect(bob).addERC20(tradeId, await token.getAddress(), 1);

      const trade = await escrow.getTrade(tradeId);
      expect(trade.initiatorApproved).to.equal(false);
      expect(trade.counterpartyApproved).to.equal(false);
    });
  });

  describe("settlement", function () {
    it("swaps both bundles exactly, or neither approval is enough", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, token, nft, alice, bob, aliceTokens, bobTokens } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      const tokenAddress = await token.getAddress();
      const nftAddress = await nft.getAddress();
      const alicePays = hre.ethers.parseEther("100");
      const bobPays = hre.ethers.parseEther("250");

      await escrow.connect(alice).addNFT(tradeId, nftAddress, 1);
      await escrow.connect(alice).addERC20(tradeId, tokenAddress, alicePays);
      await escrow.connect(bob).addNFT(tradeId, nftAddress, 2);
      await escrow.connect(bob).addERC20(tradeId, tokenAddress, bobPays);

      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));
      expect((await escrow.getTrade(tradeId)).executed).to.equal(false);
      expect(await nft.ownerOf(1)).to.equal(alice.address);

      await expect(escrow.connect(bob).approveTrade(tradeId, await bundleVersion(escrow, tradeId)))
        .to.emit(escrow, "TradeCompleted")
        .withArgs(tradeId);

      expect(await nft.ownerOf(1)).to.equal(bob.address);
      expect(await nft.ownerOf(2)).to.equal(alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(aliceTokens - alicePays + bobPays);
      expect(await token.balanceOf(bob.address)).to.equal(bobTokens - bobPays + alicePays);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
      expect((await escrow.getTrade(tradeId)).executed).to.equal(true);

      await expect(escrow.connect(alice).cancelTrade(tradeId))
        .to.be.revertedWithCustomError(escrow, "TradeAlreadyExecuted");
    });

    it("does not settle a one-sided offer", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));

      await expect(escrow.connect(bob).approveTrade(tradeId, await bundleVersion(escrow, tradeId)))
        .to.be.revertedWithCustomError(escrow, "EmptyOffer")
        .withArgs(bob.address);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it("lets either party cancel an open trade", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);

      await expect(escrow.connect(bob).cancelTrade(tradeId))
        .to.emit(escrow, "TradeCancelled")
        .withArgs(tradeId);
      await expect(escrow.getTrade(tradeId)).to.be.revertedWithCustomError(escrow, "TradeNotFound");
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });
  });

  describe("non-standard ERC-20", function () {
    it("reverts a false return and leaves the NFT with its owner", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      const bad = await (await hre.ethers.getContractFactory("FalseReturnERC20")).deploy();
      const payment = 1_000n;
      await bad.mint(bob.address, payment);
      await bad.connect(bob).approve(await escrow.getAddress(), payment);
      await nft.connect(alice).setApprovalForAll(await escrow.getAddress(), true);

      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);
      await escrow.connect(bob).addERC20(tradeId, await bad.getAddress(), payment);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));

      // Bob's token reports failure instead of reverting. The NFT leg must roll back with it.
      await expect(escrow.connect(bob).approveTrade(tradeId, await bundleVersion(escrow, tradeId)))
        .to.be.revertedWithCustomError(escrow, "SafeERC20FailedOperation")
        .withArgs(await bad.getAddress());

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await bad.balanceOf(bob.address)).to.equal(payment);
      expect(await bad.balanceOf(alice.address)).to.equal(0);
      expect((await escrow.getTrade(tradeId)).executed).to.equal(false);
    });

    it("reverts a fee-on-transfer payment without moving the other side", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      const feeToken = await (await hre.ethers.getContractFactory("FeeOnTransferERC20")).deploy();
      const payment = 1_000n;
      await feeToken.mint(bob.address, payment);
      await feeToken.connect(bob).approve(await escrow.getAddress(), payment);
      await nft.connect(alice).setApprovalForAll(await escrow.getAddress(), true);

      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);
      await escrow.connect(bob).addERC20(tradeId, await feeToken.getAddress(), payment);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));

      await expect(escrow.connect(bob).approveTrade(tradeId, await bundleVersion(escrow, tradeId)))
        .to.be.revertedWithCustomError(escrow, "FeeOnTransferNotSupported");

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await feeToken.balanceOf(bob.address)).to.equal(payment);
      expect(await feeToken.balanceOf(alice.address)).to.equal(0);
    });

    it("settles a USDT-style token that returns no data", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, alice, bob } = ctx;
      const usdt = await (await hre.ethers.getContractFactory("NoReturnERC20")).deploy();
      const payment = 500n;
      const ask = 125n;
      await usdt.mint(alice.address, payment);
      await usdt.mint(bob.address, ask);
      await usdt.connect(alice).approve(await escrow.getAddress(), payment);
      await usdt.connect(bob).approve(await escrow.getAddress(), ask);

      const tradeId = await readTradeId(escrow, await escrow.connect(alice).createTrade(bob.address, await openDeadline()));
      const usdtAddress = await usdt.getAddress();
      await escrow.connect(alice).addERC20(tradeId, usdtAddress, payment);
      await escrow.connect(bob).addERC20(tradeId, usdtAddress, ask);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));
      await escrow.connect(bob).approveTrade(tradeId, await bundleVersion(escrow, tradeId));

      expect(await usdt.balanceOf(alice.address)).to.equal(ask);
      expect(await usdt.balanceOf(bob.address)).to.equal(payment);
      expect((await escrow.getTrade(tradeId)).executed).to.equal(true);
    });
  });

  describe("reentrancy", function () {
    it("finishes the swap when the payer tries to cancel from the token callback", async function () {
      const { escrow, nft, alice } = await loadFixture(deployFixture);
      const token = await (await hre.ethers.getContractFactory("CallbackERC20")).deploy();
      const party = await (await hre.ethers.getContractFactory("MaliciousParty")).deploy();
      const payment = hre.ethers.parseEther("10");
      const escrowAddress = await escrow.getAddress();
      const tokenAddress = await token.getAddress();

      await token.mint(await party.getAddress(), payment);
      await nft.connect(alice).setApprovalForAll(escrowAddress, true);

      const tradeId = await readTradeId(
        escrow,
        await escrow.connect(alice).createTrade(await party.getAddress(), await openDeadline())
      );
      await party.track(escrowAddress, tradeId, tokenAddress);
      await party.approveToken(tokenAddress, escrowAddress, payment);
      await party.addERC20(tradeId, tokenAddress, payment);
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);
      await escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId));
      await token.arm();
      await party.approveTrade(tradeId, await bundleVersion(escrow, tradeId));

      expect(await party.cancelled()).to.equal(false);
      expect(await nft.ownerOf(1)).to.equal(await party.getAddress());
      expect(await token.balanceOf(alice.address)).to.equal(payment);
      expect(await token.balanceOf(await party.getAddress())).to.equal(0);
      expect((await escrow.getTrade(tradeId)).executed).to.equal(true);
    });
  });

  describe("bundle binding", function () {
    it("does not settle a bundle Bob has not approved", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, token, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const tradeId = await readTradeId(
        escrow,
        await escrow.connect(alice).createTrade(bob.address, await openDeadline())
      );
      const nftAddress = await nft.getAddress();
      const tokenAddress = await token.getAddress();

      await escrow.connect(alice).addNFT(tradeId, nftAddress, 1);
      await escrow.connect(bob).addERC20(tradeId, tokenAddress, 1_000n);
      const seen = await bundleVersion(escrow, tradeId);
      await escrow.connect(alice).approveTrade(tradeId, seen);

      await escrow.connect(alice).removeAsset(tradeId, 0);
      await escrow.connect(alice).addERC20(tradeId, tokenAddress, 1n);
      const rewritten = await bundleVersion(escrow, tradeId);
      await escrow.connect(alice).approveTrade(tradeId, rewritten);

      await expect(escrow.connect(bob).approveTrade(tradeId, seen))
        .to.be.revertedWithCustomError(escrow, "StaleBundle")
        .withArgs(rewritten);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect((await escrow.getTrade(tradeId)).executed).to.equal(false);
    });

    it("stops new approvals after the deadline and still allows cancel", async function () {
      const ctx = await loadFixture(deployFixture);
      const { escrow, nft, alice, bob } = ctx;
      await approveStandardAssets(ctx);
      const deadline = (await time.latest()) + 100;
      const tradeId = await readTradeId(
        escrow,
        await escrow.connect(alice).createTrade(bob.address, deadline)
      );
      await escrow.connect(alice).addNFT(tradeId, await nft.getAddress(), 1);

      await time.increaseTo(deadline + 1);
      await expect(
        escrow.connect(alice).approveTrade(tradeId, await bundleVersion(escrow, tradeId))
      ).to.be.revertedWithCustomError(escrow, "TradeExpired");
      await expect(escrow.connect(bob).cancelTrade(tradeId)).to.emit(escrow, "TradeCancelled");
    });

    it("rejects a deadline that is not in the future", async function () {
      const { escrow, alice, bob } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(escrow.connect(alice).createTrade(bob.address, now))
        .to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });
  });
});
