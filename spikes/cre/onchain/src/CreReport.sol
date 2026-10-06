// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Builds the 109-byte CRE report header exactly as the CRE simulator's fake consensus does
///         (chainlink core/capabilities/fakes/consensus_nodag.go -> consensustypes.Metadata.Encode):
///         version(1) | executionId(32) | timestamp(4) | donId(4) | donConfigVersion(4) |
///         workflowId(32) | workflowName(10) | workflowOwner(20) | reportId(2)
///         The (Mock)KeystoneForwarder passes rawReport[45:109] (64 bytes) as `metadata` and rawReport[109:] as `report`.
library CreReport {
    // Values hard-coded by the simulator (core/services/workflows/cmd/cre/utils/standalone_engine.go)
    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_WORKFLOW_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    uint32 internal constant SIM_TIMESTAMP = 100;
    bytes2 internal constant SIM_REPORT_ID = 0x0001;

    function header(
        bytes32 executionId,
        uint32 donId,
        uint32 donConfigVersion,
        bytes32 workflowId,
        bytes10 workflowName,
        address workflowOwner,
        bytes2 reportId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(1), executionId, SIM_TIMESTAMP, donId, donConfigVersion, workflowId, workflowName, workflowOwner, reportId
        );
    }

    /// @notice CRE workflow-name encoding: first 10 hex chars of sha256(name), as ASCII bytes.
    function encodeName(string memory name) internal pure returns (bytes10 out) {
        bytes32 h = sha256(bytes(name));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory s = new bytes(10);
        for (uint256 i; i < 5; ++i) {
            s[2 * i] = hexChars[uint8(h[i]) >> 4];
            s[2 * i + 1] = hexChars[uint8(h[i]) & 0x0f];
        }
        assembly {
            out := mload(add(s, 32))
        }
    }
}
