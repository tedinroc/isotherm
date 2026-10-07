// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IIsothermResolver
/// @notice The read surface the CollateralVault needs from the Resolver.
interface IIsothermResolver {
    enum Status {
        None, // no result yet
        Settled, // tmaxC is final once block.timestamp >= finalAt; YES wins iff tmaxC >= strike
        Void // sources disagreed, guardian challenge, or no report within the stale window: YES and NO each pay 0.5
    }

    /// @dev Packed into one storage slot (status, tmaxC, resolvedAt, finalAt) + sourcesHash.
    struct Result {
        Status status;
        int16 tmaxC; // 0 for Void
        uint64 resolvedAt; // when the result was first recorded
        uint64 finalAt; // redemption opens at this timestamp (Settled: resolvedAt + challengeWindow; Void: when voided)
        bytes32 sourcesHash; // hash of the raw observations the attester signed over (0 for a stale void)
    }

    /// @notice UTC timestamp at which the station-local day `date` ends. Reverts for unknown stations / bad dates.
    function dayEnd(bytes4 station, uint32 date) external view returns (uint256);

    /// @notice The ladder result for (station, date).
    function resultOf(bytes4 station, uint32 date) external view returns (Result memory);
}
