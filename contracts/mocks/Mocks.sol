// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ISealable} from "../ISealable.sol";
import {TradeEscrow} from "../TradeEscrow.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock Token", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock NFT", "MNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice Transfer returns false and moves no balances.
/// @dev Models the non-standard ERC-20 that makes an unchecked `transferFrom`
///      look successful while the payer keeps the tokens.
contract FalseReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice `transferFrom` succeeds but delivers only 90% of `amount`.
contract FeeOnTransferERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        uint256 fee = amount / 10;
        if (fee == 0) fee = 1;
        require(amount > fee, "fee");

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

/// @notice USDT-style ERC-20: `transferFrom` moves tokens and returns no data.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice On the next `transferFrom`, calls `from.onTransfer()` before moving tokens.
contract CallbackERC20 is ERC20 {
    bool public armed;

    constructor() ERC20("Callback Token", "CALL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm() external {
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            (bool ok,) = from.call(abi.encodeWithSignature("onTransfer()"));
            ok;
        }
        return super.transferFrom(from, to, amount);
    }
}

/// @notice Counterparty that tries to cancel the trade from inside the token callback.
contract MaliciousParty {
    TradeEscrow public escrow;
    bytes32 public tradeId;
    address public token;
    bool public cancelled;

    function track(address escrow_, bytes32 tradeId_, address token_) external {
        escrow = TradeEscrow(escrow_);
        tradeId = tradeId_;
        token = token_;
    }

    function approveToken(address token_, address spender, uint256 amount) external {
        require(IERC20(token_).approve(spender, amount), "approve");
    }

    function addERC20(bytes32 id, address token_, uint256 amount) external {
        escrow.addERC20(id, token_, amount);
    }

    function approveTrade(bytes32 id, uint256 bundleVersion) external {
        escrow.approveTrade(id, bundleVersion);
    }

    function onTransfer() external {
        require(msg.sender == token, "hook");
        try escrow.cancelTrade(tradeId) {
            cancelled = true;
        } catch {}
    }
}

/// @notice Container NFT used to test the seal check. Not a Schrödinger's Box.
contract MockSealable is ERC721, ISealable {
    mapping(uint256 => bool) public shadow;
    mapping(uint256 => bool) private _sealed;
    mapping(uint256 => uint256) private _state;

    constructor() ERC721("Sealable", "SEAL") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function seal(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "owner");
        require(!_sealed[tokenId], "sealed");
        _sealed[tokenId] = true;
        _state[tokenId] += 1;
    }

    function unseal(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "owner");
        require(_sealed[tokenId], "open");
        _sealed[tokenId] = false;
        _state[tokenId] += 1;
    }

    function markShadow(uint256 tokenId) external {
        shadow[tokenId] = true;
    }

    /// @dev Moves the token onto this contract, the way a bridge locks an original.
    function park(uint256 tokenId) external {
        _transfer(ownerOf(tokenId), address(this), tokenId);
    }

    function isSealed(uint256 tokenId) public view returns (bool) {
        require(_ownerOf(tokenId) != address(0), "missing");
        if (shadow[tokenId]) return true;
        return _sealed[tokenId];
    }

    function sealState(uint256 tokenId) public view returns (uint256) {
        require(_ownerOf(tokenId) != address(0), "missing");
        return _state[tokenId];
    }

    function contentHash(uint256 tokenId) public view returns (bytes32) {
        require(_ownerOf(tokenId) != address(0), "missing");
        return keccak256(abi.encode(tokenId, _state[tokenId]));
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ISealable).interfaceId || super.supportsInterface(interfaceId);
    }
}

/// @notice Tells a contract recipient that the token arrived, even though the escrow uses `transferFrom`.
contract ArrivalERC721 is ERC721 {
    constructor() ERC721("Arrival", "ARR") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        super.transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            (bool ok,) = to.call(abi.encodeWithSignature("onTokenArrived()"));
            ok;
        }
    }
}

/// @notice Seller that unseals its container when Bob's token arrives mid-settlement.
contract SellerWallet {
    MockSealable public box;
    uint256 public boxId;

    function setBox(address box_, uint256 id) external {
        box = MockSealable(box_);
        boxId = id;
    }

    function approveEscrow(address nft, address escrow) external {
        IERC721(nft).setApprovalForAll(escrow, true);
    }

    function addNFT(address escrow, bytes32 id, address nft, uint256 tokenId) external {
        TradeEscrow(escrow).addNFT(id, nft, tokenId);
    }

    function approveTrade(address escrow, bytes32 id, uint256 version) external {
        TradeEscrow(escrow).approveTrade(id, version);
    }

    function sealBox() external {
        box.seal(boxId);
    }

    function onTokenArrived() external {
        box.unseal(boxId);
    }
}
