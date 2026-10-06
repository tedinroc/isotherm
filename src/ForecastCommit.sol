// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {StationTime} from "./lib/StationTime.sol";

/// @title Isotherm ForecastCommit
/// @notice Commit-reveal log for daily temperature forecasts, so a calibration record cannot be backfilled.
///         Anyone can keep a record (commits are keyed by msg.sender); Isotherm's own maker is one forecaster.
///
///   1. Before the station-local day `date` begins, `commit(station, date, hash)` with
///        hash = forecastHash(forecaster, station, date, strikesC, probBps, salt)
///      A commit can never be overwritten.
///   2. Any time later, `reveal(station, date, strikesC, probBps, salt)` emits the forecast:
///        probBps[i] = P(Tmax >= strikesC[i]) in basis points (0..10000), strikes strictly increasing.
///
/// The only admin power is registering a station's UTC offset, which is write-once.
contract ForecastCommit is Ownable2Step {
    struct Commitment {
        bytes32 hash;
        uint64 committedAt;
        uint64 revealedAt;
    }

    struct StationConfig {
        int32 utcOffset;
        bool registered;
    }

    uint256 public constant MAX_STRIKES = 64;
    uint16 public constant BPS = 10_000;

    mapping(bytes4 station => StationConfig) public stations;
    mapping(address forecaster => mapping(bytes4 station => mapping(uint32 date => Commitment))) private _commits;

    event StationRegistered(bytes4 indexed station, int32 utcOffset);
    event ForecastCommitted(
        address indexed forecaster, bytes4 indexed station, uint32 indexed date, bytes32 hash, uint256 deadline
    );
    event ForecastRevealed(
        address indexed forecaster,
        bytes4 indexed station,
        uint32 indexed date,
        int16[] strikesC,
        uint16[] probBps,
        bytes32 salt,
        uint64 committedAt
    );

    error UnknownStation(bytes4 station);
    error StationAlreadyRegistered(bytes4 station);
    error CommitWindowClosed(uint256 deadline);
    error AlreadyCommitted();
    error EmptyHash();
    error NoCommit();
    error AlreadyRevealed();
    error HashMismatch();
    error BadForecast();

    constructor(address owner_) Ownable(owner_) {}

    function registerStation(bytes4 station, int32 utcOffset) external onlyOwner {
        StationTime.validateStation(station);
        StationTime.validateOffset(utcOffset);
        if (stations[station].registered) revert StationAlreadyRegistered(station);
        stations[station] = StationConfig({utcOffset: utcOffset, registered: true});
        emit StationRegistered(station, utcOffset);
    }

    /// @notice Last moment (exclusive) to commit a forecast for `date`: the local midnight that starts that day.
    function commitDeadline(bytes4 station, uint32 date) public view returns (uint256) {
        StationConfig memory s = stations[station];
        if (!s.registered) revert UnknownStation(station);
        return StationTime.localDayStart(date, s.utcOffset);
    }

    function commit(bytes4 station, uint32 date, bytes32 hash) external {
        if (hash == bytes32(0)) revert EmptyHash();
        uint256 deadline = commitDeadline(station, date);
        if (block.timestamp >= deadline) revert CommitWindowClosed(deadline);
        Commitment storage c = _commits[msg.sender][station][date];
        if (c.hash != bytes32(0)) revert AlreadyCommitted();
        c.hash = hash;
        c.committedAt = uint64(block.timestamp);
        emit ForecastCommitted(msg.sender, station, date, hash, deadline);
    }

    function reveal(bytes4 station, uint32 date, int16[] calldata strikesC, uint16[] calldata probBps, bytes32 salt)
        external
    {
        Commitment storage c = _commits[msg.sender][station][date];
        if (c.hash == bytes32(0)) revert NoCommit();
        if (c.revealedAt != 0) revert AlreadyRevealed();
        if (forecastHash(msg.sender, station, date, strikesC, probBps, salt) != c.hash) revert HashMismatch();
        _validate(strikesC, probBps);
        c.revealedAt = uint64(block.timestamp);
        emit ForecastRevealed(msg.sender, station, date, strikesC, probBps, salt, c.committedAt);
    }

    function forecastHash(
        address forecaster,
        bytes4 station,
        uint32 date,
        int16[] calldata strikesC,
        uint16[] calldata probBps,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(forecaster, station, date, strikesC, probBps, salt));
    }

    function commitmentOf(address forecaster, bytes4 station, uint32 date) external view returns (Commitment memory) {
        return _commits[forecaster][station][date];
    }

    function _validate(int16[] calldata strikesC, uint16[] calldata probBps) private pure {
        uint256 n = strikesC.length;
        if (n == 0 || n > MAX_STRIKES || probBps.length != n) revert BadForecast();
        for (uint256 i; i < n; ++i) {
            if (probBps[i] > BPS) revert BadForecast();
            if (i > 0 && strikesC[i] <= strikesC[i - 1]) revert BadForecast();
        }
    }
}
