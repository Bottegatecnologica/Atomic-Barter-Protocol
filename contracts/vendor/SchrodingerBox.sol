// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
/// @dev Copy of the box repository's SchrodingerBox. The import path is the only edit.
import {ISealable} from "../ISealable.sol";

/**
 * @notice Interface for Wormhole Relayer
 */
interface IWormholeRelayer {
    function sendPayloadToEvm(
        uint16 targetChain,
        address targetAddress,
        bytes memory payload,
        uint256 receiverValue,
        uint256 gasLimit
    ) external payable returns (uint64 sequence);

    function quoteEVMDeliveryPrice(
        uint16 targetChain, 
        uint256 receiverValue, 
        uint256 gasLimit
    ) external view returns (uint256 deliveryPrice, uint256 wormholeFee);
}

/**
 * @notice Interface for a contract which can receive Wormhole messages.
 */
interface IWormholeReceiver {
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable;
}

interface IERC4906 {
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}

contract SchrodingerBox is ERC721Enumerable, Ownable2Step, ReentrancyGuard, IWormholeReceiver, ISealable, IERC4906 {
    using SafeERC20 for IERC20;

    /// @dev Caps each kind so a deposit loop cannot be grown without bound.
    uint256 public constant MAX_ASSETS = 20;

    /// @dev External containers re-read while a box is sealed. Nested boxes of this
    ///      contract are not counted: their contents cannot change while held here.
    uint256 public constant MAX_EXTERNAL_SEALS = 8;

    /// @dev Caps a hostile `contentHash`. A sealed box of this contract is one storage read.
    uint256 private constant EXTERNAL_HASH_GAS = 50_000;
    uint8 public constant ASSET_ERC20 = 0;
    uint8 public constant ASSET_ERC721 = 1;

    struct Asset {
        address contractAddress;
        uint256 tokenId;
        uint256 amount;
        uint8 assetType; // 0 ERC20, 1 ERC721
    }

    struct Box {
        Asset[] assets;
        bool isLocked;
        uint16 originChain;
        bool isOriginal;
        uint256 creationTime;
        bytes32 messageNonce;
        uint256 originBoxId;
    }

    // Replay protection for Wormhole deliveries.
    mapping(bytes32 => bool) public processedMessages;
    
    IWormholeRelayer public immutable wormholeRelayer;

    mapping(uint16 => bytes32) public trustedContracts;
    uint16 public immutable chainId;

    mapping(uint256 => Box) public boxes;

    address public feeCollector;
    uint256 public mintingFee;
    uint256 private _tokenIdCounter;

    /// @dev Base gas figure used only by the price quote, plus one increment per listed asset.
    ///      A full box writes about 80 storage slots; 500k is not enough for that.
    ///      The mailbox does not forward this number as a stipend. Whoever calls `deliver` pays the destination gas.
    uint256 public constant BASE_DELIVERY_GAS = 800_000;
    uint256 public constant GAS_PER_ASSET = 60_000;

    /// @dev Set by `freezeConfig`. After that, trusted peers cannot be replaced.
    bool public configFrozen;

    struct ExternalSeal {
        address nft;
        uint256 tokenId;
    }

    struct Seal {
        bool closed;
        uint256 state;
        bytes32 contentHash;
    }

    mapping(uint256 => Seal) private _seals;
    mapping(uint256 => ExternalSeal[]) private _externalSeals;

    // Events
    event BoxMinted(address indexed owner, uint256 indexed boxId);
    event ERC20Deposited(uint256 indexed boxId, address indexed token, uint256 amount);
    event ERC20Withdrawn(uint256 indexed boxId, address indexed token, uint256 amount);
    event NFTDeposited(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId);
    event NFTWithdrawn(uint256 indexed boxId, address indexed nftContract, uint256 nftTokenId);
    event BoxBridged(uint256 indexed boxId, uint16 indexed dstChainId, bytes32 indexed targetContract);
    event BoxReceived(uint256 indexed boxId, address indexed receiver);
    event ShadowBoxReturned(uint256 indexed boxId, uint16 indexed originalChain);
    event MintingFeeUpdated(uint256 newFee);
    event FeeCollectorUpdated(address newFeeCollector);
    event TrustedContractUpdated(uint16 chainId, bytes32 contractAddress);
    event ConfigFrozenSet();
    event Sealed(uint256 indexed boxId, uint256 state);
    event Unsealed(uint256 indexed boxId, uint256 state);
    event BridgeError(string reason);

    // Errors
    error NotBoxOwner();
    error BoxLocked();
    error BoxNotLocked();
    error InsufficientBalance();
    error InsufficientMintingFee();
    error InsufficientWormholeFee();
    error FeeSendFailed();
    error UntrustedSource();
    error NotOriginalBox();
    error NotShadowBox();
    error InvalidTargetChain();
    error InvalidAddress();
    error NotWormholeRelayer();
    error MessageAlreadyProcessed();
    error BridgeFailed(string reason);
    error ZeroAmount();
    error TooManyAssets();
    error DuplicateAsset();
    error AssetNotReceived();
    error UnknownAction();
    error ConfigFrozen();
    error BoxSealed();
    error AlreadySealed();
    error NotSealed();
    error NonceMismatch();
    error SelfDeposit();
    error ExternalHashFailed();
    error TooManyExternalSeals();

    constructor(
        address _wormholeRelayer,
        uint16 _chainId,
        address initialOwner
    ) ERC721("Schrodinger Box", "SBOX") Ownable(initialOwner) {
        require(_wormholeRelayer != address(0), "Invalid relayer address");
        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        chainId = _chainId;
        feeCollector = initialOwner;
        _tokenIdCounter = 0;
    }

    /// @dev Caller must be the configured Wormhole relayer.
    modifier onlyWormholeRelayer() {
        if (msg.sender != address(wormholeRelayer)) revert NotWormholeRelayer();
        _;
    }

    function _nextTokenId() internal returns (uint256) {
        unchecked {
            _tokenIdCounter++;
        }
        return _tokenIdCounter;
    }

    /// @notice Updates the address that receives minting fees.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert InvalidAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    /// @notice Updates the ETH fee charged when a box is minted.
    function setMintingFee(uint256 _fee) external onlyOwner {
        mintingFee = _fee;
        emit MintingFeeUpdated(_fee);
    }

    /// @notice Registers the box contract trusted on another chain.
    /// @param _contractAddress Target contract, encoded as bytes32.
    function setTrustedContract(uint16 _chainId, bytes32 _contractAddress) external onlyOwner {
        if (configFrozen) revert ConfigFrozen();
        trustedContracts[_chainId] = _contractAddress;
        emit TrustedContractUpdated(_chainId, _contractAddress);
    }

    /// @notice Stops later changes to the trusted box on each chain. Irreversible.
    function freezeConfig() external onlyOwner {
        if (configFrozen) revert ConfigFrozen();
        configFrozen = true;
        emit ConfigFrozenSet();
    }

    /// @notice Closes the box and stores `contentHash`. Deposits and withdrawals revert until `unseal`.
    /// @dev The stored hash is what `contentHash` returns while the box is sealed, so a later
    ///      read does not walk the asset list. External containers are the exception: up to
    ///      `MAX_EXTERNAL_SEALS` of them are read again on each call.
    function seal(uint256 boxId) external {
        _requireOpenOriginal(boxId);
        Seal storage sealInfo = _seals[boxId];
        if (sealInfo.closed) revert AlreadySealed();
        delete _externalSeals[boxId];
        _recordExternalSeals(boxId, boxId, 0);
        sealInfo.contentHash = _contentHash(boxId, 0);
        sealInfo.closed = true;
        sealInfo.state += 1;
        emit Sealed(boxId, sealInfo.state);
        emit MetadataUpdate(boxId);
    }

    /// @notice Opens the box again. The seal counter still increases.
    function unseal(uint256 boxId) external {
        _requireOpenOriginal(boxId);
        Seal storage sealInfo = _seals[boxId];
        if (!sealInfo.closed) revert NotSealed();
        delete _externalSeals[boxId];
        sealInfo.contentHash = bytes32(0);
        sealInfo.closed = false;
        sealInfo.state += 1;
        emit Unsealed(boxId, sealInfo.state);
        emit MetadataUpdate(boxId);
    }

    /// @inheritdoc ISealable
    function isSealed(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        if (!boxes[tokenId].isOriginal) return true;
        return _seals[tokenId].closed;
    }

    /// @inheritdoc ISealable
    function sealState(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        return _seals[tokenId].state;
    }

    /// @inheritdoc ISealable
    /// @dev A sealed original, and every shadow, returns the hash stored when the list was frozen.
    ///      An open original still walks the list, because that list can still change.
    function contentHash(uint256 tokenId) public view returns (bytes32) {
        _requireOwned(tokenId);
        if (!_hashFrozen(tokenId)) return _contentHash(tokenId, 0);
        bytes32 hash = _seals[tokenId].contentHash;
        ExternalSeal[] storage extra = _externalSeals[tokenId];
        uint256 n = extra.length;
        for (uint256 i = 0; i < n; i++) {
            hash = keccak256(abi.encode(hash, _readExternalHash(extra[i].nft, extra[i].tokenId)));
        }
        return hash;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ISealable).interfaceId || interfaceId == 0x49064906
            || super.supportsInterface(interfaceId);
    }

    /// @notice Mints a box. Excess ETH above the minting fee is returned with a call, not `transfer`.
    function mintBox() external payable nonReentrant returns (uint256) {
        if (msg.value < mintingFee) revert InsufficientMintingFee();

        if (mintingFee > 0) {
            (bool success,) = payable(feeCollector).call{value: mintingFee}("");
            if (!success) revert FeeSendFailed();
        }

        uint256 boxId = _nextTokenId();

        Box storage created = boxes[boxId];
        created.isLocked = false;
        created.originChain = chainId;
        created.isOriginal = true;
        created.creationTime = block.timestamp;
        created.messageNonce = bytes32(0);
        created.originBoxId = boxId;

        _safeMint(msg.sender, boxId);
        _refundExcess(mintingFee);

        emit BoxMinted(msg.sender, boxId);
        return boxId;
    }

    /// @notice Deposits ERC-20 into a box. The box records the amount that actually arrived.
    /// @dev `safeTransferFrom` reverts when the token returns false. A fee-on-transfer
    ///      token is credited for the balance increase, so a later withdraw cannot
    ///      pull tokens that were deposited into other boxes.
    function depositERC20(
        uint256 boxId,
        address token,
        uint256 amount
    ) external nonReentrant {
        _requireOpenOriginal(boxId);
        if (_seals[boxId].closed) revert BoxSealed();
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 received = _pullERC20(token, amount);

        Asset[] storage assets = boxes[boxId].assets;
        uint256 erc20s = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType != ASSET_ERC20) continue;
            erc20s++;
            if (assets[i].contractAddress == token) {
                assets[i].amount += received;
                emit ERC20Deposited(boxId, token, received);
                return;
            }
        }

        if (erc20s >= MAX_ASSETS) revert TooManyAssets();
        assets.push(Asset({contractAddress: token, tokenId: 0, amount: received, assetType: ASSET_ERC20}));
        emit ERC20Deposited(boxId, token, received);
    }

    /// @notice Withdraws one ERC-20 balance from a box.
    function withdrawERC20(
        uint256 boxId, 
        address token
    ) external nonReentrant {
        _requireOpenOriginal(boxId);
        if (_seals[boxId].closed) revert BoxSealed();

        Asset[] storage assets = boxes[boxId].assets;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType == ASSET_ERC20 && assets[i].contractAddress == token) {
                uint256 amount = assets[i].amount;
                _removeAsset(assets, i);

                IERC20(token).safeTransfer(msg.sender, amount);
                emit ERC20Withdrawn(boxId, token, amount);
                return;
            }
        }
        
        revert InsufficientBalance();
    }

    /// @notice Deposits an NFT into a box.
    function depositNFT(
        uint256 boxId,
        address nftContract,
        uint256 tokenId
    ) external nonReentrant {
        _requireOpenOriginal(boxId);
        if (_seals[boxId].closed) revert BoxSealed();
        if (nftContract == address(0)) revert InvalidAddress();
        if (nftContract == address(this) && tokenId == boxId) revert SelfDeposit();
        Asset[] storage assets = boxes[boxId].assets;
        uint256 nfts = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType != ASSET_ERC721) continue;
            nfts++;
            if (assets[i].contractAddress == nftContract && assets[i].tokenId == tokenId) {
                revert DuplicateAsset();
            }
        }
        if (nfts >= MAX_ASSETS) revert TooManyAssets();

        IERC721 nft = IERC721(nftContract);
        nft.transferFrom(msg.sender, address(this), tokenId);
        if (nft.ownerOf(tokenId) != address(this)) revert AssetNotReceived();

        assets.push(Asset({contractAddress: nftContract, tokenId: tokenId, amount: 0, assetType: ASSET_ERC721}));

        emit NFTDeposited(boxId, nftContract, tokenId);
    }

    /// @notice Withdraws one NFT from a box.
    function withdrawNFT(
        uint256 boxId, 
        address nftContract, 
        uint256 tokenId
    ) external nonReentrant {
        _requireOpenOriginal(boxId);
        if (_seals[boxId].closed) revert BoxSealed();

        Asset[] storage assets = boxes[boxId].assets;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType == ASSET_ERC721 && assets[i].contractAddress == nftContract && assets[i].tokenId == tokenId) {
                _removeAsset(assets, i);

                IERC721(nftContract).transferFrom(address(this), msg.sender, tokenId);
                emit NFTWithdrawn(boxId, nftContract, tokenId);
                return;
            }
        }
        
        revert InsufficientBalance();
    }

    /// @notice Gas forwarded with a delivery for a box that lists `assetCount` assets.
    function deliveryGasLimit(uint256 assetCount) public pure returns (uint256) {
        return BASE_DELIVERY_GAS + assetCount * GAS_PER_ASSET;
    }

    /// @notice Quotes the Wormhole delivery fee for an empty box.
    function getWormholeFee(uint16 targetChain) public view returns (uint256) {
        return getWormholeFee(targetChain, 0);
    }

    /// @notice Quotes the Wormhole delivery fee for a box with `assetCount` listed assets.
    /// @dev If the relayer cannot price the message, this reverts. There is no fallback fee.
    function getWormholeFee(uint16 targetChain, uint256 assetCount) public view returns (uint256) {
        (uint256 deliveryPrice,) = wormholeRelayer.quoteEVMDeliveryPrice(
            targetChain,
            0, // No receiver value
            deliveryGasLimit(assetCount)
        );
        return deliveryPrice;
    }

    /// @dev Unique nonce mixed into each Wormhole payload.
    function generateMessageNonce(uint256 boxId) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            address(this),
            boxId,
            block.timestamp,
            block.number,
            msg.sender
        ));
    }

    /// @notice Locks this box and asks Wormhole to mint a shadow box on `targetChain`.
    function bridgeBox(
        uint16 targetChain,
        address receiver,
        uint256 boxId
    ) external payable nonReentrant {
        if (ownerOf(boxId) != msg.sender) revert NotBoxOwner();
        if (!boxes[boxId].isOriginal) revert NotOriginalBox();
        if (boxes[boxId].isLocked) revert BoxLocked();
        if (receiver == address(0)) revert InvalidAddress();
        if (targetChain == chainId) revert InvalidTargetChain();
        
        bytes32 targetContract = trustedContracts[targetChain];
        if (targetContract == bytes32(0)) revert InvalidTargetChain();
        if (receiver == address(uint160(uint256(targetContract)))) revert InvalidAddress();

        bytes32 messageNonce = generateMessageNonce(boxId);
        boxes[boxId].messageNonce = messageNonce;
        
        // Prepare message for the target
        bytes memory payload = abi.encode(
            uint8(1), // action: 1 = bridge
            boxId,
            boxes[boxId],
            receiver,
            messageNonce
        );

        // Send message with Wormhole - improved error handling
        uint256 assetCount = boxes[boxId].assets.length;
        uint256 wormholeFee = getWormholeFee(targetChain, assetCount);
        if (msg.value < wormholeFee) revert InsufficientWormholeFee();

        try wormholeRelayer.sendPayloadToEvm{value: wormholeFee}(
            targetChain,
            address(uint160(uint256(targetContract))),
            payload,
            0, // No additional fee
            deliveryGasLimit(assetCount)
        ) returns (uint64) {
            // The contract holds the original. No wallet owns it until the shadow comes home.
            _transfer(msg.sender, address(this), boxId);
            boxes[boxId].isLocked = true;

            _refundExcess(wormholeFee);

            emit BoxBridged(boxId, targetChain, targetContract);
        } catch Error(string memory reason) {
            // Log and rethrow specific errors
            emit BridgeError(reason);
            revert BridgeFailed(reason);
        } catch {
            // Handle unknown errors
            emit BridgeError("Unknown error");
            revert BridgeFailed("Unknown error");
        }
    }

    /// @notice Burns a shadow box and asks the origin chain to unlock the original for `receiver`.
    function returnShadowBox(uint256 boxId, address receiver) external payable nonReentrant {
        if (ownerOf(boxId) != msg.sender) revert NotBoxOwner();
        if (boxes[boxId].isOriginal) revert NotShadowBox();
        if (receiver == address(0)) revert InvalidAddress();
        
        uint16 targetChain = boxes[boxId].originChain;
        bytes32 targetContract = trustedContracts[targetChain];
        if (targetContract == bytes32(0)) revert InvalidTargetChain();
        if (receiver == address(uint160(uint256(targetContract)))) revert InvalidAddress();

        uint256 originBoxId = boxes[boxId].originBoxId;
        if (originBoxId == 0) revert NotShadowBox();

        bytes32 messageNonce = generateMessageNonce(boxId);

        // The id in the message is the original box, not this shadow's local id.
        bytes memory payload = abi.encode(
            uint8(2), // action: 2 = return
            originBoxId,
            boxes[boxId],
            receiver,
            messageNonce
        );

        // Send message with Wormhole - improved error handling
        uint256 assetCount = boxes[boxId].assets.length;
        uint256 wormholeFee = getWormholeFee(targetChain, assetCount);
        if (msg.value < wormholeFee) revert InsufficientWormholeFee();

        try wormholeRelayer.sendPayloadToEvm{value: wormholeFee}(
            targetChain,
            address(uint160(uint256(targetContract))),
            payload,
            0, // No additional fee
            deliveryGasLimit(assetCount)
        ) returns (uint64) {
            // Burn the shadow box
            _burn(boxId);
            
            _refundExcess(wormholeFee);

            emit ShadowBoxReturned(boxId, targetChain);
        } catch Error(string memory reason) {
            // Log and rethrow specific errors
            emit BridgeError(reason);
            revert BridgeFailed(reason);
        } catch {
            // Handle unknown errors
            emit BridgeError("Unknown error");
            revert BridgeFailed("Unknown error");
        }
    }

    /// @notice Wormhole delivery entrypoint. Mints a shadow box or unlocks an original.
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32
    ) external payable override onlyWormholeRelayer nonReentrant {
        bytes32 expectedSourceAddress = trustedContracts[sourceChain];
        if (expectedSourceAddress != sourceAddress) revert UntrustedSource();

        (uint8 action, uint256 boxId, Box memory boxData, address receiver, bytes32 messageNonce) = abi.decode(
            payload,
            (uint8, uint256, Box, address, bytes32)
        );

        if (processedMessages[messageNonce]) revert MessageAlreadyProcessed();
        processedMessages[messageNonce] = true;

        (uint256 erc20s, uint256 nfts) = _countKinds(boxData);
        if (erc20s > MAX_ASSETS || nfts > MAX_ASSETS) revert TooManyAssets();
        if (receiver == address(0)) revert InvalidAddress();

        if (action == 1) {
            // A shadow gets a fresh local id. Reusing `boxId` collides with a box this chain already minted.
            uint256 localId = _nextTokenId();
            Box storage shadow = boxes[localId];
            shadow.isOriginal = false;
            shadow.isLocked = false;
            shadow.originChain = boxData.originChain;
            shadow.creationTime = boxData.creationTime;
            shadow.messageNonce = messageNonce;
            shadow.originBoxId = boxId;
            for (uint256 i = 0; i < boxData.assets.length; i++) {
                shadow.assets.push(boxData.assets[i]);
            }
            _seals[localId].contentHash = _contentHash(localId, 0);
            _recordExternalSeals(localId, localId, 0);
            // `_mint`, not `_safeMint`. A contract receiver with no `onERC721Received`
            // must not revert delivery, or the original stays locked with no exit.
            _mint(receiver, localId);

            emit BoxReceived(localId, receiver);
        } else if (action == 2) {
            // The shadow's copy says isOriginal = false. Trust the box stored here, not that flag.
            Box storage original = boxes[boxId];
            if (!original.isOriginal || original.originChain != chainId) revert NotOriginalBox();
            if (!original.isLocked) revert BoxNotLocked();
            // The shadow still carries the nonce saved when this original was bridged.
            if (boxData.messageNonce != original.messageNonce) revert NonceMismatch();

            original.isLocked = false;
            _seals[boxId].state += 1;
            emit MetadataUpdate(boxId);
            address holder = ownerOf(boxId);
            if (holder != receiver) {
                _transfer(holder, receiver, boxId);
            }

            emit BoxReceived(boxId, receiver);
        } else {
            revert UnknownAction();
        }
    }

    /// @dev A locked original sits on this contract. Only unlocking it, which happens before the transfer home, lets it move.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to != address(0) && _ownerOf(tokenId) != address(0) && boxes[tokenId].isLocked) {
            revert BoxLocked();
        }
        return super._update(to, tokenId, auth);
    }

    /// @dev Caller owns an original box that is not locked in a bridge.
    ///      A box nested inside this contract is owned by this contract, so no
    ///      wallet can deposit, withdraw, seal, or unseal it until it is withdrawn.
    function _requireOpenOriginal(uint256 boxId) internal view {
        if (ownerOf(boxId) != msg.sender) revert NotBoxOwner();
        if (!boxes[boxId].isOriginal) revert NotOriginalBox();
        if (boxes[boxId].isLocked) revert BoxLocked();
    }

    /// @dev Pulls `amount` and returns the balance that actually arrived.
    function _pullERC20(address token, uint256 amount) internal returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();
    }

    /// @dev Returns unused ETH. Uses call so a contract wallet is not limited to 2300 gas.
    function _refundExcess(uint256 spent) internal {
        if (msg.value > spent) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - spent}("");
            if (!ok) revert FeeSendFailed();
        }
    }

    /// @notice Returns the assets and bridge state stored for a box.
    function getBoxDetails(uint256 boxId) external view returns (
        Asset[] memory assets,
        bool isLocked,
        uint16 originChain,
        bool isOriginal,
        uint256 originBoxId
    ) {
        Box storage box = boxes[boxId];
        return (
            box.assets,
            box.isLocked,
            box.originChain,
            box.isOriginal,
            box.originBoxId
        );
    }

    /// @notice Returns the recorded balance of one ERC-20 inside a box.
    function getERC20Balance(uint256 boxId, address token) external view returns (uint256 amount) {
        Asset[] storage assets = boxes[boxId].assets;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType == ASSET_ERC20 && assets[i].contractAddress == token) {
                return assets[i].amount;
            }
        }
        return 0;
    }

    /// @notice Returns whether a box currently lists an NFT.
    function containsNFT(uint256 boxId, address nftContract, uint256 tokenId) external view returns (bool exists) {
        Asset[] storage assets = boxes[boxId].assets;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType == ASSET_ERC721 && assets[i].contractAddress == nftContract && assets[i].tokenId == tokenId) {
                return true;
            }
        }
        return false;
    }

    function _hashFrozen(uint256 tokenId) internal view returns (bool) {
        if (!boxes[tokenId].isOriginal) return true;
        return _seals[tokenId].closed;
    }

    /// @dev Writes the external containers whose hash must stay live. Nested boxes of this
    ///      contract are walked, not recorded: holding them freezes their own list.
    function _recordExternalSeals(uint256 rootId, uint256 tokenId, uint256 depth) internal {
        if (depth >= 4) return;
        Asset[] storage assets = boxes[tokenId].assets;
        uint256 length = assets.length;
        for (uint256 i = 0; i < length; i++) {
            if (assets[i].assetType != ASSET_ERC721) continue;
            address nft = assets[i].contractAddress;
            if (nft == address(this)) {
                _recordExternalSeals(rootId, assets[i].tokenId, depth + 1);
            } else if (_reportsSealable(nft)) {
                if (_externalSeals[rootId].length >= MAX_EXTERNAL_SEALS) revert TooManyExternalSeals();
                _externalSeals[rootId].push(ExternalSeal({nft: nft, tokenId: assets[i].tokenId}));
            }
        }
    }

    function _contentHash(uint256 tokenId, uint256 depth) internal view returns (bytes32) {
        if (depth >= 4) return bytes32(0);
        Asset[] storage assets = boxes[tokenId].assets;
        bytes32[] memory parts = new bytes32[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            bytes32 child;
            if (assets[i].assetType == ASSET_ERC721) {
                address nft = assets[i].contractAddress;
                uint256 nestedId = assets[i].tokenId;
                if (nft == address(this)) {
                    child = _hashFrozen(nestedId) ? contentHash(nestedId) : _contentHash(nestedId, depth + 1);
                } else {
                    child = _externalContentHash(nft, nestedId);
                }
            }
            parts[i] = keccak256(abi.encode(
                assets[i].contractAddress,
                assets[i].tokenId,
                assets[i].amount,
                assets[i].assetType,
                child
            ));
        }
        return keccak256(abi.encode(chainId, tokenId, parts));
    }

    function _reportsSealable(address nft) internal view returns (bool) {
        (bool supported, bytes memory data) = nft.staticcall{gas: EXTERNAL_HASH_GAS}(
            abi.encodeCall(IERC165.supportsInterface, (type(ISealable).interfaceId))
        );
        return supported && data.length >= 32 && abi.decode(data, (bool));
    }

    /// @dev A plain NFT contributes zero. A contract that claims `ISealable` but does not
    ///      return a hash reverts, so the missing contents are not silently unbound.
    function _externalContentHash(address nft, uint256 tokenId) internal view returns (bytes32) {
        if (!_reportsSealable(nft)) return bytes32(0);
        return _readExternalHash(nft, tokenId);
    }

    function _readExternalHash(address nft, uint256 tokenId) internal view returns (bytes32) {
        (bool hashed, bytes memory hashData) = nft.staticcall{gas: EXTERNAL_HASH_GAS}(
            abi.encodeCall(ISealable.contentHash, (tokenId))
        );
        if (!hashed || hashData.length < 32) revert ExternalHashFailed();
        return abi.decode(hashData, (bytes32));
    }

    function _removeAsset(Asset[] storage assets, uint256 index) internal {
        assets[index] = assets[assets.length - 1];
        assets.pop();
    }

    /// @dev Counts the two kinds in a decoded box. Any other type is rejected.
    function _countKinds(Box memory boxData) internal pure returns (uint256 erc20s, uint256 nfts) {
        for (uint256 i = 0; i < boxData.assets.length; i++) {
            uint8 kind = boxData.assets[i].assetType;
            if (kind == ASSET_ERC20) erc20s++;
            else if (kind == ASSET_ERC721) nfts++;
            else revert UnknownAction();
        }
    }
}