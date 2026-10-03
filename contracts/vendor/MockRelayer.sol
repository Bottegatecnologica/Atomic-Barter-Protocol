// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDeliveredBox {
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable;
}

/// @notice Records one Wormhole send and can deliver that payload to a box.
contract MockRelayer {
    uint16 public lastTargetChain;
    address public lastTarget;
    bytes public lastPayload;
    uint256 public lastGasLimit;
    uint256 public quote;
    bool public revertQuote;

    error QuoteUnavailable();

    function setQuote(uint256 nextQuote) external {
        quote = nextQuote;
    }

    function setRevertQuote(bool next) external {
        revertQuote = next;
    }

    function quoteEVMDeliveryPrice(
        uint16,
        uint256,
        uint256
    ) external view returns (uint256 deliveryPrice, uint256 wormholeFee) {
        if (revertQuote) revert QuoteUnavailable();
        return (quote, 0);
    }

    function sendPayloadToEvm(
        uint16 targetChain,
        address targetAddress,
        bytes memory payload,
        uint256,
        uint256 gasLimit
    ) external payable returns (uint64) {
        lastTargetChain = targetChain;
        lastTarget = targetAddress;
        lastPayload = payload;
        lastGasLimit = gasLimit;
        return 1;
    }

    function deliver(address box, uint16 sourceChain, bytes32 sourceAddress) external {
        _deliver(box, lastPayload, sourceChain, sourceAddress);
    }

    function deliverPayload(address box, bytes calldata payload, uint16 sourceChain, bytes32 sourceAddress) external {
        _deliver(box, payload, sourceChain, sourceAddress);
    }

    function _deliver(address box, bytes memory payload, uint16 sourceChain, bytes32 sourceAddress) internal {
        IDeliveredBox(box).receiveWormholeMessages(
            payload,
            new bytes[](0),
            sourceAddress,
            sourceChain,
            bytes32(uint256(1))
        );
    }
}
