// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A container NFT whose contents cannot change while it is sealed.
/// @dev `sealState` increases every time the seal closes or opens, and when the
///      container changes in a way a buyer has to notice. Integrators compare
///      the value they stored at listing with the value at settlement.
///      A nested SchrodingerBox is owned by the outer box contract. Every
///      state-changing entrypoint requires `ownerOf(tokenId) == msg.sender`,
///      so the inner box cannot be sealed, unsealed, deposited into, or
///      withdrawn from while it sits inside. The seal of an outer box is
///      therefore recursive only for containers whose control follows `ownerOf`.
///      This interface id is published. A later field belongs on a new interface,
///      not on this one. `contentHash` is already part of the published id.
interface ISealable {
    /// @notice Whether `tokenId` is sealed. A shadow box is always sealed.
    function isSealed(uint256 tokenId) external view returns (bool);

    /// @notice Monotonic counter for `tokenId`. It is not a contents hash.
    function sealState(uint256 tokenId) external view returns (uint256);

    /// @notice Hash of what `tokenId` holds, including nested containers.
    function contentHash(uint256 tokenId) external view returns (bytes32);
}
