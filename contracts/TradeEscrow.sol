// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ISealable} from "./ISealable.sol";
import {ILegacySealable} from "./legacy/ILegacySealable.sol";

/// @title TradeEscrow
/// @notice Two-party atomic swaps of ERC-20 and ERC-721 bundles.
/// @dev Assets stay in the owners' wallets until both parties approve the same
///      bundle version. Settlement then runs in one transaction: every leg
///      succeeds, or the whole trade reverts. The contract never custodies assets.
contract TradeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Caps each side of a trade so settlement cannot be grown without
    ///      bound. One party could otherwise add enough items to make the
    ///      execution loop run out of gas.
    uint256 public constant MAX_ASSETS_PER_PARTY = 20;

    /// @dev An approval cannot stay valid forever. Thirty days is the longest open trade.
    uint256 public constant MAX_TRADE_DURATION = 30 days;

    /// @dev A hostile container cannot spend the caller's whole gas stipend.
    uint256 private constant SEAL_CALL_GAS = 50_000;

    enum AssetType {
        ERC20,
        ERC721
    }

    struct Asset {
        address contractAddress;
        uint256 tokenId;
        uint256 amount;
        AssetType assetType;
        bool sealedContainer;
        uint256 sealState;
        bytes32 contentHash;
    }

    struct Trade {
        address initiator;
        address counterparty;
        bool initiatorApproved;
        bool counterpartyApproved;
        bool executed;
        uint256 deadline;
        uint256 version;
    }

    /// @dev Asset lists live outside `Trade`. A struct `delete` does not clear
    ///      nested mappings, so cancel would otherwise leave the bundles behind.
    mapping(bytes32 => Trade) private _trades;
    mapping(bytes32 => mapping(address => Asset[])) private _assets;
    uint256 private _tradeNonce;

    event TradeCreated(
        bytes32 indexed tradeId, address indexed initiator, address indexed counterparty, uint256 deadline
    );
    event AssetAdded(
        bytes32 indexed tradeId,
        address indexed owner,
        address indexed contractAddress,
        uint8 assetType,
        uint256 tokenId,
        uint256 amount,
        uint256 sealState,
        bytes32 contentHash
    );
    event AssetRemoved(
        bytes32 indexed tradeId,
        address indexed owner,
        address indexed contractAddress,
        uint256 tokenId,
        uint256 amount
    );
    event TradeApproved(bytes32 indexed tradeId, address indexed party, uint256 bundleVersion);
    event TradeCompleted(bytes32 indexed tradeId);
    event TradeCancelled(bytes32 indexed tradeId);

    error InvalidCounterparty();
    error SelfTrade();
    error TradeNotFound();
    error TradeAlreadyExecuted();
    error InvalidDeadline();
    error TradeExpired();
    error StaleBundle(uint256 currentVersion);
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
    error ContainerNotSealed();
    error ContentChanged();
    error LegacyContainer();

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
            uint256 counterpartyAssetCount,
            uint256 deadline,
            uint256 version
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
        deadline = trade.deadline;
        version = trade.version;
    }

    function getAssets(bytes32 tradeId, address party) external view returns (Asset[] memory) {
        if (_trades[tradeId].initiator == address(0)) revert TradeNotFound();
        return _assets[tradeId][party];
    }

    /// @notice Opens a trade that can be approved until `deadline` (a unix timestamp).
    function createTrade(address counterparty, uint256 deadline) external returns (bytes32 tradeId) {
        if (counterparty == address(0)) revert InvalidCounterparty();
        if (counterparty == msg.sender) revert SelfTrade();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_TRADE_DURATION) revert InvalidDeadline();

        uint256 nonce = ++_tradeNonce;
        tradeId = keccak256(abi.encode(msg.sender, counterparty, block.timestamp, nonce));

        Trade storage trade = _trades[tradeId];
        trade.initiator = msg.sender;
        trade.counterparty = counterparty;
        trade.deadline = deadline;

        emit TradeCreated(tradeId, msg.sender, counterparty, deadline);
    }

    /// @notice Lists an NFT. The caller must have approved this escrow for the token or the collection.
    ///         Settlement uses `transferFrom`, which does not ask the recipient to accept the NFT.
    function addNFT(bytes32 tradeId, address nftContract, uint256 tokenId) external nonReentrant {
        Trade storage trade = _requireLiveParticipant(tradeId);
        if (nftContract == address(0)) revert ZeroAddress();

        Asset[] storage items = _assets[tradeId][msg.sender];
        if (items.length >= MAX_ASSETS_PER_PARTY) revert TooManyAssets();
        if (_containsNft(items, nftContract, tokenId)) revert DuplicateNft();

        IERC721 nft = IERC721(nftContract);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotNftOwner();
        if (!nft.isApprovedForAll(msg.sender, address(this)) && nft.getApproved(tokenId) != address(this)) {
            revert NftNotApproved();
        }

        (bool sealedContainer, uint256 sealState, bytes32 contentHash) = _readSeal(nftContract, tokenId);

        items.push(Asset({
            contractAddress: nftContract,
            tokenId: tokenId,
            amount: 1,
            assetType: AssetType.ERC721,
            sealedContainer: sealedContainer,
            sealState: sealState,
            contentHash: contentHash
        }));

        _bumpBundle(trade);
        emit AssetAdded(tradeId, msg.sender, nftContract, uint8(AssetType.ERC721), tokenId, 1, sealState, contentHash);
    }

    function addERC20(bytes32 tradeId, address tokenContract, uint256 amount) external nonReentrant {
        Trade storage trade = _requireLiveParticipant(tradeId);
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
            assetType: AssetType.ERC20,
            sealedContainer: false,
            sealState: 0,
            contentHash: bytes32(0)
        }));

        _bumpBundle(trade);
        emit AssetAdded(tradeId, msg.sender, tokenContract, uint8(AssetType.ERC20), 0, amount, 0, bytes32(0));
    }

    /// @notice Removes one of the caller's listed assets. Uses swap-and-pop, so
    ///         later indexes move. Both approvals are cleared and the bundle version increments.
    function removeAsset(bytes32 tradeId, uint256 index) external nonReentrant {
        Trade storage trade = _requireLiveParticipant(tradeId);

        Asset[] storage items = _assets[tradeId][msg.sender];
        if (index >= items.length) revert InvalidIndex();

        Asset memory removed = items[index];
        uint256 last = items.length - 1;
        if (index != last) {
            items[index] = items[last];
        }
        items.pop();

        _bumpBundle(trade);
        emit AssetRemoved(tradeId, msg.sender, removed.contractAddress, removed.tokenId, removed.amount);
    }

    /// @notice Approves bundle `bundleVersion`. The second matching approval settles the trade.
    /// @dev Passing the version the caller reviewed stops a counterparty from changing the
    ///      bundle and having this transaction settle the new one.
    function approveTrade(bytes32 tradeId, uint256 bundleVersion) external nonReentrant {
        Trade storage trade = _requireLiveParticipant(tradeId);
        if (trade.version != bundleVersion) revert StaleBundle(trade.version);
        if (_assets[tradeId][msg.sender].length == 0) revert EmptyOffer(msg.sender);

        if (msg.sender == trade.initiator) {
            trade.initiatorApproved = true;
        } else {
            trade.counterpartyApproved = true;
        }

        emit TradeApproved(tradeId, msg.sender, bundleVersion);

        if (trade.initiatorApproved && trade.counterpartyApproved) {
            _executeTrade(tradeId);
        }
    }

    function cancelTrade(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _requireParticipant(tradeId);
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
        // A token received during settlement can call back into a container the
        // seller still holds, or into one that just arrived. Check again after
        // every leg has moved, before the lists are deleted.
        _recheckSeals(_assets[tradeId][initiator]);
        _recheckSeals(_assets[tradeId][counterparty]);

        delete _assets[tradeId][initiator];
        delete _assets[tradeId][counterparty];

        emit TradeCompleted(tradeId);
    }

    function _transferAll(Asset[] storage items, address from, address to) internal {
        uint256 length = items.length;
        for (uint256 i; i < length;) {
            Asset storage asset = items[i];
            if (asset.assetType == AssetType.ERC721) {
                _checkSeal(asset);
                address nftContract = asset.contractAddress;
                uint256 tokenId = asset.tokenId;
                IERC721 nft = IERC721(nftContract);
                nft.transferFrom(from, to, tokenId);
                if (nft.ownerOf(tokenId) != to) revert NftNotReceived();
            } else {
                address tokenContract = asset.contractAddress;
                uint256 amount = asset.amount;
                IERC20 token = IERC20(tokenContract);
                uint256 balanceBefore = token.balanceOf(to);
                // Reverts if the token returns false. Empty return data (USDT) is accepted.
                token.safeTransferFrom(from, to, amount);
                if (token.balanceOf(to) - balanceBefore != amount) {
                    revert FeeOnTransferNotSupported();
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    function _checkSeal(Asset storage asset) internal view {
        if (!asset.sealedContainer) return;
        address container = asset.contractAddress;
        if (!_staticBool(container, abi.encodeCall(ISealable.isSealed, (asset.tokenId)))) revert ContainerNotSealed();
        (bool stateOk, uint256 state) = _staticUint(container, abi.encodeCall(ISealable.sealState, (asset.tokenId)));
        if (!stateOk || state != asset.sealState) revert ContentChanged();
        (bool hashOk, bytes32 hash) = _staticBytes32(container, abi.encodeCall(ISealable.contentHash, (asset.tokenId)));
        if (!hashOk || hash != asset.contentHash) revert ContentChanged();
    }

    function _recheckSeals(Asset[] storage items) internal view {
        uint256 length = items.length;
        for (uint256 i; i < length;) {
            if (items[i].assetType == AssetType.ERC721) _checkSeal(items[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev `staticcall` so an NFT with no ERC-165 still lists. A container that
    ///      reports the current `ISealable` must already be sealed. One that reports
    ///      only the older id, from before `contentHash`, is rejected.
    function _readSeal(address nftContract, uint256 tokenId) internal view returns (bool sealedContainer, uint256 state, bytes32 hash) {
        bool current = _staticBool(nftContract, abi.encodeCall(IERC165.supportsInterface, (type(ISealable).interfaceId)));
        bool legacy = _staticBool(nftContract, abi.encodeCall(IERC165.supportsInterface, (type(ILegacySealable).interfaceId)));
        if (legacy && !current) revert LegacyContainer();
        if (!current) return (false, 0, bytes32(0));
        if (!_staticBool(nftContract, abi.encodeCall(ISealable.isSealed, (tokenId)))) revert ContainerNotSealed();
        bool stateOk;
        (stateOk, state) = _staticUint(nftContract, abi.encodeCall(ISealable.sealState, (tokenId)));
        if (!stateOk) revert ContentChanged();
        bool hashOk;
        (hashOk, hash) = _staticBytes32(nftContract, abi.encodeCall(ISealable.contentHash, (tokenId)));
        if (!hashOk) revert ContentChanged();
        return (true, state, hash);
    }

    function _staticBool(address target, bytes memory data) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall{gas: SEAL_CALL_GAS}(data);
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _staticUint(address target, bytes memory data) internal view returns (bool ok, uint256 value) {
        bytes memory ret;
        (ok, ret) = target.staticcall{gas: SEAL_CALL_GAS}(data);
        if (!ok || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    function _staticBytes32(address target, bytes memory data) internal view returns (bool ok, bytes32 value) {
        bytes memory ret;
        (ok, ret) = target.staticcall{gas: SEAL_CALL_GAS}(data);
        if (!ok || ret.length < 32) return (false, bytes32(0));
        return (true, abi.decode(ret, (bytes32)));
    }

    function _requireParticipant(bytes32 tradeId) internal view returns (Trade storage trade) {
        trade = _trades[tradeId];
        if (trade.initiator == address(0)) revert TradeNotFound();
        if (trade.executed) revert TradeAlreadyExecuted();
        if (msg.sender != trade.initiator && msg.sender != trade.counterparty) revert NotParticipant();
    }

    function _requireLiveParticipant(bytes32 tradeId) internal view returns (Trade storage trade) {
        trade = _requireParticipant(tradeId);
        if (block.timestamp > trade.deadline) revert TradeExpired();
    }

    function _bumpBundle(Trade storage trade) internal {
        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;
        unchecked {
            trade.version += 1;
        }
    }

    function _containsNft(Asset[] storage items, address nftContract, uint256 tokenId) internal view returns (bool) {
        uint256 length = items.length;
        for (uint256 i; i < length;) {
            if (
                items[i].assetType == AssetType.ERC721 && items[i].contractAddress == nftContract
                    && items[i].tokenId == tokenId
            ) {
                return true;
            }
            unchecked {
                ++i;
            }
        }
        return false;
    }

    function _listedErc20(Asset[] storage items, address tokenContract) internal view returns (uint256 total) {
        uint256 length = items.length;
        for (uint256 i; i < length;) {
            if (items[i].assetType == AssetType.ERC20 && items[i].contractAddress == tokenContract) {
                total += items[i].amount;
            }
            unchecked {
                ++i;
            }
        }
    }
}
