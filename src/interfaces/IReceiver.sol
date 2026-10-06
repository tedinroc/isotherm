// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver - receives Chainlink CRE (Keystone) reports
/// @notice Verbatim interface from Chainlink CRE docs ("Building Consumer Contracts", IReceiver standard).
///         The KeystoneForwarder / MockKeystoneForwarder checks ERC-165 support for this interface id
///         before calling `onReport`.
interface IReceiver is IERC165 {
    /// @notice Handles incoming keystone reports.
    /// @dev If this function call reverts, it can be retried with a higher gas limit.
    ///      The receiver is responsible for discarding stale reports.
    /// @param metadata Report's metadata (64 bytes from KeystoneForwarder:
    ///        workflowId(32) | workflowName(10) | workflowOwner(20) | reportId(2)).
    /// @param report Workflow report (ABI-encoded payload produced by the workflow).
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
