// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TradeEscrow
/// @notice Two-party atomic swaps of ERC-20 and ERC-721 bundles.
/// @dev Assets stay in the owners' wallets until both parties approve the same
///      bundle. Settlement then runs in one transaction: every leg succeeds, or
///      the whole trade reverts. The contract never custodies assets.
contract TradeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Caps each side of a trade so settlement cannot be grown without
    ///      bound. One party could otherwise add enough items to make the
    ///      execution loop run out of gas.
    uint256 public constant MAX_ASSETS_PER_PARTY = 20;

    enum AssetType {
        ERC20,
        ERC721
    }

    struct Asset {
        address contractAddress;
        uint256 tokenId;
        uint256 amount;
        AssetType assetType;
    }

    struct Trade {
        address initiator;
        address counterparty;
        bool initiatorApproved;
        bool counterpartyApproved;
        bool executed;
    }

    /// @dev Asset lists live outside `Trade`. A struct `delete` does not clear
    ///      nested mappings, so cancel would otherwise leave the bundles behind.
    mapping(bytes32 => Trade) private _trades;
    mapping(bytes32 => mapping(address => Asset[])) private _assets;
    uint256 private _tradeNonce;

    event TradeCreated(bytes32 indexed tradeId, address indexed initiator, address indexed counterparty);
    event AssetAdded(
        bytes32 indexed tradeId,
        address indexed owner,
        address indexed contractAddress,
        uint8 assetType,
        uint256 tokenId,
        uint256 amount
    );
    event AssetRemoved(
        bytes32 indexed tradeId,
        address indexed owner,
        address indexed contractAddress,
        uint256 tokenId,
        uint256 amount
    );
    event TradeApproved(bytes32 indexed tradeId, address indexed party);
    event TradeCompleted(bytes32 indexed tradeId);
    event TradeCancelled(bytes32 indexed tradeId);

    error InvalidCounterparty();
    error SelfTrade();
    error TradeNotFound();
    error TradeAlreadyExists();
    error TradeAlreadyExecuted();
    error NotParticipant();
    error ZeroAddress();
    error ZeroAmount();
    error NotNftOwner();
    error NftNotApproved();
    error DuplicateNft();
    error NftNotReceived();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TooManyAssets();
    error EmptyOffer(address party);
    error InvalidIndex();
    error FeeOnTransferNotSupported();

    function getTrade(bytes32 tradeId)
        external
        view
        returns (
            address initiator,
            address counterparty,
            bool initiatorApproved,
            bool counterpartyApproved,
            bool executed,
            uint256 initiatorAssetCount,
            uint256 counterpartyAssetCount
        )
    {
        Trade storage trade = _trades[tradeId];
        if (trade.initiator == address(0)) revert TradeNotFound();

        initiator = trade.initiator;
        counterparty = trade.counterparty;
        initiatorApproved = trade.initiatorApproved;
        counterpartyApproved = trade.counterpartyApproved;
        executed = trade.executed;
        initiatorAssetCount = _assets[tradeId][initiator].length;
        counterpartyAssetCount = _assets[tradeId][counterparty].length;
    }

    function getAssets(bytes32 tradeId, address party) external view returns (Asset[] memory) {
        if (_trades[tradeId].initiator == address(0)) revert TradeNotFound();
        return _assets[tradeId][party];
    }

    function createTrade(address counterparty) external nonReentrant returns (bytes32 tradeId) {
        if (counterparty == address(0)) revert InvalidCounterparty();
        if (counterparty == msg.sender) revert SelfTrade();

        uint256 nonce = ++_tradeNonce;
        tradeId = keccak256(abi.encode(msg.sender, counterparty, block.timestamp, nonce));

        Trade storage trade = _trades[tradeId];
        if (trade.initiator != address(0)) revert TradeAlreadyExists();

        trade.initiator = msg.sender;
        trade.counterparty = counterparty;

        emit TradeCreated(tradeId, msg.sender, counterparty);
    }

    function addNFT(bytes32 tradeId, address nftContract, uint256 tokenId) external nonReentrant {
        Trade storage trade = _requireOpenParticipant(tradeId);
        if (nftContract == address(0)) revert ZeroAddress();

        Asset[] storage items = _assets[tradeId][msg.sender];
        if (items.length >= MAX_ASSETS_PER_PARTY) revert TooManyAssets();
        if (_containsNft(items, nftContract, tokenId)) revert DuplicateNft();

        IERC721 nft = IERC721(nftContract);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotNftOwner();
        if (!nft.isApprovedForAll(msg.sender, address(this))) revert NftNotApproved();

        items.push(Asset({
            contractAddress: nftContract,
            tokenId: tokenId,
            amount: 1,
            assetType: AssetType.ERC721
        }));

        _resetApprovals(trade);
        emit AssetAdded(tradeId, msg.sender, nftContract, uint8(AssetType.ERC721), tokenId, 1);
    }

    function addERC20(bytes32 tradeId, address tokenContract, uint256 amount) external nonReentrant {
        Trade storage trade = _requireOpenParticipant(tradeId);
        if (tokenContract == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Asset[] storage items = _assets[tradeId][msg.sender];
        if (items.length >= MAX_ASSETS_PER_PARTY) revert TooManyAssets();

        uint256 needed = _listedErc20(items, tokenContract) + amount;
        IERC20 token = IERC20(tokenContract);
        if (token.balanceOf(msg.sender) < needed) revert InsufficientBalance();
        if (token.allowance(msg.sender, address(this)) < needed) revert InsufficientAllowance();

        items.push(Asset({
            contractAddress: tokenContract,
            tokenId: 0,
            amount: amount,
            assetType: AssetType.ERC20
        }));

        _resetApprovals(trade);
        emit AssetAdded(tradeId, msg.sender, tokenContract, uint8(AssetType.ERC20), 0, amount);
    }

    /// @notice Removes one of the caller's listed assets. Uses swap-and-pop, so
    ///         later indexes move. Both approvals are cleared.
    function removeAsset(bytes32 tradeId, uint256 index) external nonReentrant {
        Trade storage trade = _requireOpenParticipant(tradeId);

        Asset[] storage items = _assets[tradeId][msg.sender];
        if (index >= items.length) revert InvalidIndex();

        Asset memory removed = items[index];
        uint256 last = items.length - 1;
        if (index != last) {
            items[index] = items[last];
        }
        items.pop();

        _resetApprovals(trade);
        emit AssetRemoved(tradeId, msg.sender, removed.contractAddress, removed.tokenId, removed.amount);
    }

    /// @notice Approves the current bundle. The second approval settles the trade.
    function approveTrade(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _requireOpenParticipant(tradeId);
        if (_assets[tradeId][msg.sender].length == 0) revert EmptyOffer(msg.sender);

        if (msg.sender == trade.initiator) {
            trade.initiatorApproved = true;
        } else {
            trade.counterpartyApproved = true;
        }

        emit TradeApproved(tradeId, msg.sender);

        if (trade.initiatorApproved && trade.counterpartyApproved) {
            _executeTrade(tradeId);
        }
    }

    function cancelTrade(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _requireOpenParticipant(tradeId);
        address initiator = trade.initiator;
        address counterparty = trade.counterparty;

        delete _assets[tradeId][initiator];
        delete _assets[tradeId][counterparty];
        delete _trades[tradeId];

        emit TradeCancelled(tradeId);
    }

    /// @dev Effects are committed before the external transfers. `nonReentrant`
    ///      on the public entrypoints closes the cross-function path: a token
    ///      callback cannot cancel or edit the bundle after the first leg has moved.
    function _executeTrade(bytes32 tradeId) internal {
        Trade storage trade = _trades[tradeId];
        address initiator = trade.initiator;
        address counterparty = trade.counterparty;

        if (_assets[tradeId][initiator].length == 0) revert EmptyOffer(initiator);
        if (_assets[tradeId][counterparty].length == 0) revert EmptyOffer(counterparty);

        trade.executed = true;
        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;

        _transferAll(_assets[tradeId][initiator], initiator, counterparty);
        _transferAll(_assets[tradeId][counterparty], counterparty, initiator);

        emit TradeCompleted(tradeId);
    }

    function _transferAll(Asset[] storage items, address from, address to) internal {
        uint256 length = items.length;
        for (uint256 i = 0; i < length; ++i) {
            Asset memory asset = items[i];
            if (asset.assetType == AssetType.ERC721) {
                IERC721 nft = IERC721(asset.contractAddress);
                nft.transferFrom(from, to, asset.tokenId);
                if (nft.ownerOf(asset.tokenId) != to) revert NftNotReceived();
            } else {
                IERC20 token = IERC20(asset.contractAddress);
                uint256 balanceBefore = token.balanceOf(to);
                // Reverts if the token returns false or returns no success flag
                // that decodes to false. Empty return data (USDT) is accepted.
                token.safeTransferFrom(from, to, asset.amount);
                if (token.balanceOf(to) - balanceBefore != asset.amount) {
                    revert FeeOnTransferNotSupported();
                }
            }
        }
    }

    function _requireOpenParticipant(bytes32 tradeId) internal view returns (Trade storage trade) {
        trade = _trades[tradeId];
        if (trade.initiator == address(0)) revert TradeNotFound();
        if (trade.executed) revert TradeAlreadyExecuted();
        if (msg.sender != trade.initiator && msg.sender != trade.counterparty) revert NotParticipant();
    }

    function _resetApprovals(Trade storage trade) internal {
        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;
    }

    function _containsNft(Asset[] storage items, address nftContract, uint256 tokenId) internal view returns (bool) {
        uint256 length = items.length;
        for (uint256 i = 0; i < length; ++i) {
            if (
                items[i].assetType == AssetType.ERC721
                    && items[i].contractAddress == nftContract
                    && items[i].tokenId == tokenId
            ) {
                return true;
            }
        }
        return false;
    }

    function _listedErc20(Asset[] storage items, address tokenContract) internal view returns (uint256 total) {
        uint256 length = items.length;
        for (uint256 i = 0; i < length; ++i) {
            if (items[i].assetType == AssetType.ERC20 && items[i].contractAddress == tokenContract) {
                total += items[i].amount;
            }
        }
    }
}
