// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TradeEscrow} from "../contracts/TradeEscrow.sol";
import {MockERC20, MockERC721, FalseReturnERC20} from "../contracts/mocks/Mocks.sol";

/// @notice A completed trade moves the full bundle. A reverted trade moves nothing.
contract TradeEscrowFuzzTest is Test {
    TradeEscrow internal escrow;
    MockERC20 internal good;
    FalseReturnERC20 internal bad;
    MockERC721 internal nft;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        escrow = new TradeEscrow();
        good = new MockERC20();
        bad = new FalseReturnERC20();
        nft = new MockERC721();
    }

    function testFuzz_successfulSwapMovesExactAmounts(uint96 aliceAmount, uint96 bobAmount) public {
        vm.assume(aliceAmount > 0 && bobAmount > 0);

        good.mint(alice, aliceAmount);
        good.mint(bob, bobAmount);

        vm.prank(alice);
        good.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        good.approve(address(escrow), type(uint256).max);

        vm.prank(alice);
        bytes32 tradeId = escrow.createTrade(bob);
        vm.prank(alice);
        escrow.addERC20(tradeId, address(good), aliceAmount);
        vm.prank(bob);
        escrow.addERC20(tradeId, address(good), bobAmount);

        vm.prank(alice);
        escrow.approveTrade(tradeId);
        vm.prank(bob);
        escrow.approveTrade(tradeId);

        assertEq(good.balanceOf(alice), bobAmount);
        assertEq(good.balanceOf(bob), aliceAmount);
        assertEq(good.balanceOf(address(escrow)), 0);

        (,,,, bool executed,,) = escrow.getTrade(tradeId);
        assertTrue(executed);
    }

    /// @dev Bob "pays" with a token whose transferFrom returns false.
    ///      Alice's NFT must still be hers, and the trade must stay open.
    function testFuzz_falseReturnMovesNothing(uint96 payment, uint256 tokenId) public {
        vm.assume(payment > 0);

        nft.mint(alice, tokenId);
        bad.mint(bob, payment);

        vm.prank(alice);
        nft.setApprovalForAll(address(escrow), true);
        vm.prank(bob);
        bad.approve(address(escrow), type(uint256).max);

        vm.prank(alice);
        bytes32 tradeId = escrow.createTrade(bob);
        vm.prank(alice);
        escrow.addNFT(tradeId, address(nft), tokenId);
        vm.prank(bob);
        escrow.addERC20(tradeId, address(bad), payment);

        vm.prank(alice);
        escrow.approveTrade(tradeId);
        vm.expectRevert();
        vm.prank(bob);
        escrow.approveTrade(tradeId);

        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(bad.balanceOf(bob), payment);
        assertEq(bad.balanceOf(alice), 0);

        (,,,, bool executed,,) = escrow.getTrade(tradeId);
        assertFalse(executed);
    }
}

/// @notice Opens and settles random two-sided trades of one ERC-20.
contract ConservationHandler is Test {
    TradeEscrow public escrow;
    MockERC20 public token;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    uint256 public constant SUPPLY = 1_000_000 ether;

    constructor() {
        escrow = new TradeEscrow();
        token = new MockERC20();
        token.mint(alice, SUPPLY / 2);
        token.mint(bob, SUPPLY - (SUPPLY / 2));

        vm.prank(alice);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        token.approve(address(escrow), type(uint256).max);
    }

    function swap(uint96 rawAlice, uint96 rawBob) external {
        uint256 aliceBal = token.balanceOf(alice);
        uint256 bobBal = token.balanceOf(bob);
        if (aliceBal == 0 || bobBal == 0) return;

        uint256 aliceAmount = (uint256(rawAlice) % aliceBal) + 1;
        uint256 bobAmount = (uint256(rawBob) % bobBal) + 1;
        if (aliceAmount > aliceBal) aliceAmount = aliceBal;
        if (bobAmount > bobBal) bobAmount = bobBal;

        vm.prank(alice);
        bytes32 tradeId = escrow.createTrade(bob);
        vm.prank(alice);
        escrow.addERC20(tradeId, address(token), aliceAmount);
        vm.prank(bob);
        escrow.addERC20(tradeId, address(token), bobAmount);

        vm.prank(alice);
        escrow.approveTrade(tradeId);
        vm.prank(bob);
        escrow.approveTrade(tradeId);
    }
}

contract TradeEscrowInvariantTest is Test {
    ConservationHandler internal handler;

    function setUp() public {
        handler = new ConservationHandler();
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = handler.swap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Tokens only move between the two parties. The escrow balance stays zero.
    function invariant_tokensStayWithTheParties() public view {
        uint256 sum = handler.token().balanceOf(handler.alice())
            + handler.token().balanceOf(handler.bob())
            + handler.token().balanceOf(address(handler.escrow()));
        assertEq(sum, handler.SUPPLY());
        assertEq(handler.token().balanceOf(address(handler.escrow())), 0);
    }
}
