// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TradeEscrow is ReentrancyGuard {
    struct Trade {
        address initiator;
        address counterparty;
        bool initiatorApproved;
        bool counterpartyApproved;
        bool executed;
        mapping(address => AssetList) assets;
    }

    struct Asset {
        address contractAddress;
        uint256 tokenId;  // per NFT
        uint256 amount;   // per token ERC20
        AssetType assetType;
    }

    struct AssetList {
        Asset[] items;
        bool exists;
    }

    enum AssetType { ERC20, ERC721 }

    mapping(bytes32 => Trade) public trades;
    uint256 private _tradeNonce;

    event TradeCreated(bytes32 indexed tradeId, address initiator, address counterparty);
    event AssetAdded(bytes32 indexed tradeId, address from, address contractAddress, uint256 tokenId, uint256 amount);
    event TradeCompleted(bytes32 indexed tradeId);
    event TradeCancelled(bytes32 indexed tradeId);

    function createTrade(address _counterparty) external returns (bytes32) {
        require(_counterparty != address(0), "Invalid counterparty");
        require(_counterparty != msg.sender, "Cannot trade with yourself");

        uint256 nonce = ++_tradeNonce;
        bytes32 tradeId = keccak256(abi.encodePacked(
            msg.sender,
            _counterparty,
            block.timestamp,
            nonce
        ));

        Trade storage trade = trades[tradeId];
        require(trade.initiator == address(0), "Trade already exists");
        trade.initiator = msg.sender;
        trade.counterparty = _counterparty;
        trade.assets[msg.sender].exists = true;
        trade.assets[_counterparty].exists = true;

        emit TradeCreated(tradeId, msg.sender, _counterparty);
        return tradeId;
    }

    function addNFT(bytes32 _tradeId, address _nftContract, uint256 _tokenId) external {
        Trade storage trade = trades[_tradeId];
        require(trade.initiator != address(0), "Trade not found");
        require(!trade.executed, "Trade already completed");
        require(msg.sender == trade.initiator || msg.sender == trade.counterparty, "Not authorized");
        require(trade.assets[msg.sender].exists, "Trade not found");
        
        IERC721 nft = IERC721(_nftContract);
        require(nft.ownerOf(_tokenId) == msg.sender, "Not owner of NFT");
        require(nft.isApprovedForAll(msg.sender, address(this)), "NFT not approved");

        trade.assets[msg.sender].items.push(Asset({
            contractAddress: _nftContract,
            tokenId: _tokenId,
            amount: 1,
            assetType: AssetType.ERC721
        }));

        // Reset approvals when assets change
        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;

        emit AssetAdded(_tradeId, msg.sender, _nftContract, _tokenId, 1);
    }

    function addERC20(bytes32 _tradeId, address _tokenContract, uint256 _amount) external {
        Trade storage trade = trades[_tradeId];
        require(trade.initiator != address(0), "Trade not found");
        require(!trade.executed, "Trade already completed");
        require(msg.sender == trade.initiator || msg.sender == trade.counterparty, "Not authorized");
        require(trade.assets[msg.sender].exists, "Trade not found");
        
        IERC20 token = IERC20(_tokenContract);
        require(token.balanceOf(msg.sender) >= _amount, "Insufficient balance");
        require(token.allowance(msg.sender, address(this)) >= _amount, "Token not approved");

        trade.assets[msg.sender].items.push(Asset({
            contractAddress: _tokenContract,
            tokenId: 0,
            amount: _amount,
            assetType: AssetType.ERC20
        }));

        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;

        emit AssetAdded(_tradeId, msg.sender, _tokenContract, 0, _amount);
    }

    function approveTrade(bytes32 _tradeId) external {
        Trade storage trade = trades[_tradeId];
        require(trade.initiator != address(0), "Trade not found");
        require(!trade.executed, "Trade already completed");
        require(msg.sender == trade.initiator || msg.sender == trade.counterparty, "Not authorized");

        if (msg.sender == trade.initiator) {
            trade.initiatorApproved = true;
        } else {
            trade.counterpartyApproved = true;
        }

        if (trade.initiatorApproved && trade.counterpartyApproved) {
            _executeTrade(_tradeId);
        }
    }

    function _executeTrade(bytes32 _tradeId) internal nonReentrant {
        Trade storage trade = trades[_tradeId];
        
        // Trasferisci assets dall'initiator
        for (uint i = 0; i < trade.assets[trade.initiator].items.length; i++) {
            Asset memory asset = trade.assets[trade.initiator].items[i];
            if (asset.assetType == AssetType.ERC721) {
                IERC721(asset.contractAddress).transferFrom(
                    trade.initiator,
                    trade.counterparty,
                    asset.tokenId
                );
            } else {
                IERC20(asset.contractAddress).transferFrom(
                    trade.initiator,
                    trade.counterparty,
                    asset.amount
                );
            }
        }

        // Trasferisci assets dalla controparte
        for (uint i = 0; i < trade.assets[trade.counterparty].items.length; i++) {
            Asset memory asset = trade.assets[trade.counterparty].items[i];
            if (asset.assetType == AssetType.ERC721) {
                IERC721(asset.contractAddress).transferFrom(
                    trade.counterparty,
                    trade.initiator,
                    asset.tokenId
                );
            } else {
                IERC20(asset.contractAddress).transferFrom(
                    trade.counterparty,
                    trade.initiator,
                    asset.amount
                );
            }
        }

        trade.executed = true;
        trade.initiatorApproved = false;
        trade.counterpartyApproved = false;

        emit TradeCompleted(_tradeId);
    }

    function cancelTrade(bytes32 _tradeId) external {
        Trade storage trade = trades[_tradeId];
        require(trade.initiator != address(0), "Trade not found");
        require(!trade.executed, "Trade already completed");
        require(msg.sender == trade.initiator || msg.sender == trade.counterparty, "Not authorized");
        
        delete trades[_tradeId];
        emit TradeCancelled(_tradeId);
    }
}