// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IIsothermResolver
/// @notice The read surface the CollateralVault needs from the Resolver.
interface IIsothermResolver {
    enum Status {
        None, // no result yet
        Settled, // tmaxC is final; YES wins iff tmaxC >= strike
        Void // sources disagreed or no report within the stale window: YES and NO each pay 0.5
    }

    struct Result {
        Status status;
        int16 tmaxC;
        uint64 resolvedAt;
        bytes32 sourcesHash;
    }

    /// @notice UTC timestamp at which the station-local day `date` ends. Reverts for unknown stations / bad dates.
    function dayEnd(bytes4 station, uint32 date) external view returns (uint256);

    /// @notice The ladder result for (station, date).
    function resultOf(bytes4 station, uint32 date) external view returns (Result memory);
}
