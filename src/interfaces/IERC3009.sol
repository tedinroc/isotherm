// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC3009 (subset)
/// @notice EIP-3009 "Transfer With Authorization", the receive variant. Testnet AUSD (implementation
///         0xc1e3c7d486d6a92fbe920232e439eec2ceb112da) exposes these selectors; its EIP-712 domain is
///         {name: "Agora Dollar", version: "1", chainId, verifyingContract: AUSD proxy}.
///         Type: ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
interface IERC3009 {
    /// @dev Reverts unless msg.sender == to (front-running protection), now in (validAfter, validBefore) and the
    ///      (from, nonce) pair is unused.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
