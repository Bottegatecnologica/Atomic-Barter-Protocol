// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Copy of the box repository's SchrodingerBox. The import path is the only edit.
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../ISealable.sol";

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

contract SchrodingerBox is ERC721Enumerable, Ownable, ReentrancyGuard, IWormholeReceiver, ISealable, IERC4906 {
    using SafeERC20 for IERC20;

    /// @dev Caps each box so a deposit loop cannot be grown without bound.
    uint256 public constant MAX_ASSETS = 20;

    struct Box {
        address[] erc20Tokens;
        uint256[] erc20Amounts;
        address[] erc721Contracts;
        uint256[] erc721TokenIds;
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

    struct Seal {
        bool closed;
        uint256 state;
    }

    mapping(uint256 => Seal) private _seals;

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
    error ArrayLengthMismatch();
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

    /// @notice Closes the box. Deposits and withdrawals revert until `unseal`.
    function seal(uint256 boxId) external {
        _requireOpenOriginal(boxId);
        Seal storage sealInfo = _seals[boxId];
        if (sealInfo.closed) revert AlreadySealed();
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
        
        boxes[boxId] = Box({
            erc20Tokens: new address[](0),
            erc20Amounts: new uint256[](0),
            erc721Contracts: new address[](0),
            erc721TokenIds: new uint256[](0),
            isLocked: false,
            originChain: chainId,
            isOriginal: true,
            creationTime: block.timestamp,
            messageNonce: bytes32(0),
            originBoxId: boxId
        });

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

        address[] storage tokens = boxes[boxId].erc20Tokens;
        uint256[] storage amounts = boxes[boxId].erc20Amounts;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) {
                amounts[i] += received;
                emit ERC20Deposited(boxId, token, received);
                return;
            }
        }

        if (tokens.length >= MAX_ASSETS) revert TooManyAssets();
        tokens.push(token);
        amounts.push(received);
        emit ERC20Deposited(boxId, token, received);
    }

    /// @notice Withdraws one ERC-20 balance from a box.
    function withdrawERC20(
        uint256 boxId, 
        address token
    ) external nonReentrant {
        _requireOpenOriginal(boxId);
        if (_seals[boxId].closed) revert BoxSealed();

        for (uint i = 0; i < boxes[boxId].erc20Tokens.length; i++) {
            if (boxes[boxId].erc20Tokens[i] == token) {
                uint256 amount = boxes[boxId].erc20Amounts[i];
                
                // Remove token from arrays using last element swap method
                boxes[boxId].erc20Tokens[i] = boxes[boxId].erc20Tokens[boxes[boxId].erc20Tokens.length - 1];
                boxes[boxId].erc20Amounts[i] = boxes[boxId].erc20Amounts[boxes[boxId].erc20Amounts.length - 1];
                
                boxes[boxId].erc20Tokens.pop();
                boxes[boxId].erc20Amounts.pop();

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
        if (boxes[boxId].erc721Contracts.length >= MAX_ASSETS) revert TooManyAssets();

        for (uint256 i = 0; i < boxes[boxId].erc721Contracts.length; i++) {
            if (boxes[boxId].erc721Contracts[i] == nftContract && boxes[boxId].erc721TokenIds[i] == tokenId) {
                revert DuplicateAsset();
            }
        }

        IERC721 nft = IERC721(nftContract);
        nft.transferFrom(msg.sender, address(this), tokenId);
        if (nft.ownerOf(tokenId) != address(this)) revert AssetNotReceived();

        boxes[boxId].erc721Contracts.push(nftContract);
        boxes[boxId].erc721TokenIds.push(tokenId);

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

        for (uint i = 0; i < boxes[boxId].erc721Contracts.length; i++) {
            if (boxes[boxId].erc721Contracts[i] == nftContract && 
                boxes[boxId].erc721TokenIds[i] == tokenId) {
                
                // Remove NFT from arrays using last element swap method
                boxes[boxId].erc721Contracts[i] = boxes[boxId].erc721Contracts[boxes[boxId].erc721Contracts.length - 1];
                boxes[boxId].erc721TokenIds[i] = boxes[boxId].erc721TokenIds[boxes[boxId].erc721TokenIds.length - 1];
                
                boxes[boxId].erc721Contracts.pop();
                boxes[boxId].erc721TokenIds.pop();

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

        if (boxes[boxId].erc20Tokens.length != boxes[boxId].erc20Amounts.length) revert ArrayLengthMismatch();
        if (boxes[boxId].erc721Contracts.length != boxes[boxId].erc721TokenIds.length) revert ArrayLengthMismatch();

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
        uint256 assetCount = boxes[boxId].erc20Tokens.length + boxes[boxId].erc721Contracts.length;
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

    /// @notice Burns a shadow box and asks the origin chain to unlock the original.
    function returnShadowBox(uint256 boxId) external payable nonReentrant {
        if (ownerOf(boxId) != msg.sender) revert NotBoxOwner();
        if (boxes[boxId].isOriginal) revert NotShadowBox();
        
        uint16 targetChain = boxes[boxId].originChain;
        bytes32 targetContract = trustedContracts[targetChain];
        if (targetContract == bytes32(0)) revert InvalidTargetChain();

        if (boxes[boxId].erc20Tokens.length != boxes[boxId].erc20Amounts.length) revert ArrayLengthMismatch();
        if (boxes[boxId].erc721Contracts.length != boxes[boxId].erc721TokenIds.length) revert ArrayLengthMismatch();

        uint256 originBoxId = boxes[boxId].originBoxId;
        if (originBoxId == 0) revert NotShadowBox();

        bytes32 messageNonce = generateMessageNonce(boxId);

        // The id in the message is the original box, not this shadow's local id.
        bytes memory payload = abi.encode(
            uint8(2), // action: 2 = return
            originBoxId,
            boxes[boxId],
            msg.sender,
            messageNonce
        );

        // Send message with Wormhole - improved error handling
        uint256 assetCount = boxes[boxId].erc20Tokens.length + boxes[boxId].erc721Contracts.length;
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

        if (boxData.erc20Tokens.length != boxData.erc20Amounts.length) revert ArrayLengthMismatch();
        if (boxData.erc721Contracts.length != boxData.erc721TokenIds.length) revert ArrayLengthMismatch();
        if (boxData.erc20Tokens.length > MAX_ASSETS || boxData.erc721Contracts.length > MAX_ASSETS) revert TooManyAssets();
        if (receiver == address(0)) revert InvalidAddress();

        if (action == 1) {
            // A shadow gets a fresh local id. Reusing `boxId` collides with a box this chain already minted.
            uint256 localId = _nextTokenId();
            boxData.isOriginal = false;
            boxData.isLocked = false;
            boxData.originBoxId = boxId;
            boxData.messageNonce = messageNonce;
            boxes[localId] = boxData;
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
        address[] memory erc20Tokens,
        uint256[] memory erc20Amounts,
        address[] memory erc721Contracts,
        uint256[] memory erc721TokenIds,
        bool isLocked,
        uint16 originChain,
        bool isOriginal,
        uint256 originBoxId
    ) {
        Box storage box = boxes[boxId];
        return (
            box.erc20Tokens,
            box.erc20Amounts,
            box.erc721Contracts,
            box.erc721TokenIds,
            box.isLocked,
            box.originChain,
            box.isOriginal,
            box.originBoxId
        );
    }

    /// @notice Returns the recorded balance of one ERC-20 inside a box.
    function getERC20Balance(uint256 boxId, address token) external view returns (uint256 amount) {
        Box storage box = boxes[boxId];
        for (uint i = 0; i < box.erc20Tokens.length; i++) {
            if (box.erc20Tokens[i] == token) {
                return box.erc20Amounts[i];
            }
        }
        return 0;
    }

    /// @notice Returns whether a box currently lists an NFT.
    function containsNFT(uint256 boxId, address nftContract, uint256 tokenId) external view returns (bool exists) {
        Box storage box = boxes[boxId];
        for (uint i = 0; i < box.erc721Contracts.length; i++) {
            if (box.erc721Contracts[i] == nftContract && box.erc721TokenIds[i] == tokenId) {
                return true;
            }
        }
        return false;
    }
}