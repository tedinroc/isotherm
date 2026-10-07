// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IReceiver} from "./interfaces/IReceiver.sol";
import {IIsothermResolver} from "./interfaces/IIsothermResolver.sol";
import {StationTime} from "./lib/StationTime.sol";

/// @title Isotherm Resolver (v1)
/// @notice Chainlink CRE consumer that records the official daily maximum temperature (integer degC, METAR)
///         for a (station, local date) ladder. One result settles every strike of that city-date.
///
/// Trust model (read this before relying on a result):
///  - Roles: `owner` (admin: stations, forwarder, attester, guardian, workflow pin, unpause), `attester` (signs
///    settlement reports), `guardian` (pause; veto a Settled result to Void during the challenge window).
///    The vault's `operator` role (series creation) lives in the CollateralVault.
///  - `onReport` only accepts calls from the configured `forwarder` (CRE KeystoneForwarder in production,
///    MockKeystoneForwarder for `cre workflow simulate --broadcast`). The mock is PERMISSIONLESS, so EVERY report must
///    carry an EIP-712 signature by `attester` over (station, date, tmaxC, isVoid, sourcesHash, validUntil).
///    Attestation cannot be switched off. The domain binds chainId and this address, `validUntil` bounds how long a
///    signed-but-undelivered report stays usable, and results are write-once, so nothing can be replayed.
///  - The attester decides the outcome. The guardian can only push a Settled result to Void (0.5/0.5), and only
///    before `finalAt = resolvedAt + challengeWindow`; redemption opens at `finalAt`. Void results (reported or
///    stale) are final at once: the guardian has nothing to veto there. Owner can rotate attester/guardian.
///  - A report is only accepted after the station-local day has ended.
///  - If no result exists STALE_WINDOW (48h, > the workflow's own 36h void deadline) after the day ends, anyone may
///    void the ladder. Pause does not let this run early: while paused, `voidIfStale` is blocked, and after any
///    unpause the workflow gets RESUME_GRACE to deliver before anyone may void. Liveness bound: from
///    dayEnd + MAX_STALE_WINDOW (7 days) anyone may void, paused or not, so funds can never be locked forever.
contract Resolver is IReceiver, IIsothermResolver, EIP712, Ownable2Step, Pausable {
    struct StationConfig {
        int32 utcOffset; // seconds east of UTC, e.g. +28800 for Taipei (UTC+8)
        bool registered;
    }

    /// @notice EIP-712 struct signed by the attester. Domain: name "Isotherm Resolver", version "1".
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil)"
    );

    /// @notice Anyone may void a ladder this long after its local day ended if no result exists (and not paused).
    uint256 public constant STALE_WINDOW = 48 hours;
    /// @notice After an unpause, stale voids wait at least this long so the workflow can deliver pending reports.
    uint256 public constant RESUME_GRACE = 24 hours;
    /// @notice From dayEnd + MAX_STALE_WINDOW anyone may void an unresolved ladder, even while paused.
    uint256 public constant MAX_STALE_WINDOW = 7 days;
    /// @notice Upper bound for the deploy-time challenge window.
    uint256 public constant MAX_CHALLENGE_WINDOW = 2 days;

    /// @notice Sanity bounds for a reported daily max (degC). World records are -89.2 and +56.7.
    int16 public constant MIN_TMAX_C = -90;
    int16 public constant MAX_TMAX_C = 70;

    /// @notice Seconds after a Settled result during which the guardian may convert it to Void; redemption opens after.
    uint256 public immutable challengeWindow;

    address public forwarder;
    address public attester;
    address public guardian;
    bytes32 public expectedWorkflowId;
    address public expectedWorkflowOwner;
    /// @notice Timestamp of the last unpause (0 if never unpaused).
    uint64 public lastUnpausedAt;

    mapping(bytes4 station => StationConfig) public stations;
    mapping(bytes4 station => mapping(uint32 date => Result)) private _results;

    event StationRegistered(bytes4 indexed station, int32 utcOffset);
    event ForwarderUpdated(address indexed previous, address indexed current);
    event AttesterUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowUpdated(bytes32 workflowId, address workflowOwner);
    event LadderResolved(
        bytes4 indexed station, uint32 indexed date, Status status, int16 tmaxC, bytes32 sourcesHash, address caller
    );
    event LadderChallenged(
        bytes4 indexed station, uint32 indexed date, int16 previousTmaxC, bytes32 reasonHash, address guardian
    );

    error ZeroAddress();
    error InvalidSender(address sender, address expected);
    error InvalidMetadata();
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidWorkflowOwner(address received, address expected);
    error InvalidAttestation(address recovered);
    error AttestationExpired(uint64 validUntil);
    error UnknownStation(bytes4 station);
    error StationAlreadyRegistered(bytes4 station);
    error DayNotOver(bytes4 station, uint32 date, uint256 dayEnd);
    error NotStale(bytes4 station, uint32 date, uint256 staleAt);
    error AlreadyResolved(bytes4 station, uint32 date);
    error TmaxOutOfRange(int16 tmaxC);
    error NotGuardian();
    error ChallengeWindowTooLong(uint256 challengeWindow);
    error NotChallengeable(bytes4 station, uint32 date);

    constructor(address owner_, address forwarder_, address attester_, address guardian_, uint256 challengeWindow_)
        EIP712("Isotherm Resolver", "1")
        Ownable(owner_)
    {
        if (forwarder_ == address(0) || attester_ == address(0)) revert ZeroAddress();
        if (challengeWindow_ > MAX_CHALLENGE_WINDOW) revert ChallengeWindowTooLong(challengeWindow_);
        forwarder = forwarder_;
        attester = attester_;
        guardian = guardian_;
        challengeWindow = challengeWindow_;
        emit ForwarderUpdated(address(0), forwarder_);
        emit AttesterUpdated(address(0), attester_);
        emit GuardianUpdated(address(0), guardian_);
    }

    // ---------------------------------------------------------------------------------------------
    // CRE entrypoint
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev `report` = abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash,
    ///      uint64 validUntil, bytes signature), where signature is a 65-byte ECDSA signature (r|s|v, low-s) by
    ///      `attester` over `settlementDigest(station, date, tmaxC, isVoid, sourcesHash, validUntil)`. Accepted while
    ///      block.timestamp <= validUntil.
    function onReport(bytes calldata metadata, bytes calldata report) external whenNotPaused {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        _checkWorkflowMetadata(metadata);

        (
            bytes4 station,
            uint32 date,
            int16 tmaxC,
            bool isVoid,
            bytes32 sourcesHash,
            uint64 validUntil,
            bytes memory signature
        ) = abi.decode(report, (bytes4, uint32, int16, bool, bytes32, uint64, bytes));

        if (block.timestamp > validUntil) revert AttestationExpired(validUntil);
        address signer =
            ECDSA.recover(settlementDigest(station, date, tmaxC, isVoid, sourcesHash, validUntil), signature);
        if (signer != attester) revert InvalidAttestation(signer);

        if (isVoid) {
            _resolve(station, date, Status.Void, 0, sourcesHash, 0);
        } else {
            if (tmaxC < MIN_TMAX_C || tmaxC > MAX_TMAX_C) revert TmaxOutOfRange(tmaxC);
            _resolve(station, date, Status.Settled, tmaxC, sourcesHash, challengeWindow);
        }
    }

    /// @notice Void a ladder that has no result by `staleAt(station, date)`. Callable by anyone.
    function voidIfStale(bytes4 station, uint32 date) external {
        uint256 t = staleAt(station, date);
        if (block.timestamp < t) revert NotStale(station, date, t);
        _resolve(station, date, Status.Void, 0, bytes32(0), 0);
    }

    /// @notice Guardian veto: convert a Settled result to Void before it is final (block.timestamp < finalAt).
    /// @param reasonHash e.g. keccak256 of a public incident note; only emitted.
    function challenge(bytes4 station, uint32 date, bytes32 reasonHash) external {
        if (msg.sender != guardian) revert NotGuardian();
        Result storage r = _results[station][date];
        if (r.status != Status.Settled || block.timestamp >= r.finalAt) revert NotChallengeable(station, date);
        int16 previous = r.tmaxC;
        r.status = Status.Void;
        r.tmaxC = 0;
        r.finalAt = uint64(block.timestamp);
        emit LadderChallenged(station, date, previous, reasonHash, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IIsothermResolver
    function dayEnd(bytes4 station, uint32 date) public view returns (uint256) {
        StationConfig memory s = stations[station];
        if (!s.registered) revert UnknownStation(station);
        return StationTime.localDayEnd(date, s.utcOffset);
    }

    /// @inheritdoc IIsothermResolver
    function resultOf(bytes4 station, uint32 date) external view returns (Result memory) {
        return _results[station][date];
    }

    /// @notice True once a result exists and its challenge window is over (what redemption requires).
    function isFinal(bytes4 station, uint32 date) external view returns (bool) {
        Result memory r = _results[station][date];
        return r.status != Status.None && block.timestamp >= r.finalAt;
    }

    /// @notice Earliest time `voidIfStale` can succeed given the current pause state:
    ///         paused   -> dayEnd + MAX_STALE_WINDOW
    ///         unpaused -> min(max(dayEnd + STALE_WINDOW, lastUnpausedAt + RESUME_GRACE), dayEnd + MAX_STALE_WINDOW)
    function staleAt(bytes4 station, uint32 date) public view returns (uint256) {
        uint256 end = dayEnd(station, date);
        uint256 hardMax = end + MAX_STALE_WINDOW;
        if (paused()) return hardMax;
        uint256 t = end + STALE_WINDOW;
        uint256 resume = uint256(lastUnpausedAt) + RESUME_GRACE;
        if (resume > t) t = resume;
        return t < hardMax ? t : hardMax;
    }

    /// @notice The EIP-712 digest the attester must sign for a report.
    function settlementDigest(
        bytes4 station,
        uint32 date,
        int16 tmaxC,
        bool isVoid,
        bytes32 sourcesHash,
        uint64 validUntil
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SETTLEMENT_TYPEHASH, station, date, tmaxC, isVoid, sourcesHash, validUntil))
        );
    }

    /// @notice EIP-712 domain separator (chainId + this address are bound in).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Register a station's UTC offset. Write-once, so a ladder's observation window can never move.
    function registerStation(bytes4 station, int32 utcOffset) external onlyOwner {
        StationTime.validateStation(station);
        StationTime.validateOffset(utcOffset);
        if (stations[station].registered) revert StationAlreadyRegistered(station);
        stations[station] = StationConfig({utcOffset: utcOffset, registered: true});
        emit StationRegistered(station, utcOffset);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert ZeroAddress();
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    function setAttester(address attester_) external onlyOwner {
        if (attester_ == address(0)) revert ZeroAddress();
        emit AttesterUpdated(attester, attester_);
        attester = attester_;
    }

    /// @dev address(0) disables the guardian (pause then stays possible for the owner; no challenges).
    function setGuardian(address guardian_) external onlyOwner {
        emit GuardianUpdated(guardian, guardian_);
        guardian = guardian_;
    }

    /// @notice Pin the CRE workflow identity carried in `metadata` (production KeystoneForwarder only;
    ///         the MockKeystoneForwarder lets the caller write it). Zero values disable the respective check.
    ///         Defence in depth only: the attestation is always required.
    function setExpectedWorkflow(bytes32 workflowId, address workflowOwner) external onlyOwner {
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        emit ExpectedWorkflowUpdated(workflowId, workflowOwner);
    }

    /// @notice Emergency stop for `onReport` (e.g. suspected attester key compromise). Guardian or owner.
    ///         Also blocks `voidIfStale` until dayEnd + MAX_STALE_WINDOW.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    /// @notice Owner only. Starts a RESUME_GRACE period during which no stale void can happen.
    function unpause() external onlyOwner {
        lastUnpausedAt = uint64(block.timestamp);
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _resolve(bytes4 station, uint32 date, Status status, int16 tmaxC, bytes32 sourcesHash, uint256 delay)
        internal
    {
        uint256 end = dayEnd(station, date); // reverts for unknown station / invalid date
        if (block.timestamp < end) revert DayNotOver(station, date, end);
        Result storage r = _results[station][date];
        if (r.status != Status.None) revert AlreadyResolved(station, date);
        r.status = status;
        r.tmaxC = tmaxC;
        r.resolvedAt = uint64(block.timestamp);
        r.finalAt = uint64(block.timestamp + delay);
        r.sourcesHash = sourcesHash;
        emit LadderResolved(station, date, status, tmaxC, sourcesHash, msg.sender);
    }

    /// @dev Production KeystoneForwarder passes 64 bytes: workflowId(32) | workflowName(10) | owner(20) | reportId(2).
    function _checkWorkflowMetadata(bytes calldata metadata) internal view {
        bytes32 wantId = expectedWorkflowId;
        address wantOwner = expectedWorkflowOwner;
        if (wantId == bytes32(0) && wantOwner == address(0)) return;
        if (metadata.length < 62) revert InvalidMetadata();
        if (wantId != bytes32(0)) {
            bytes32 gotId = bytes32(metadata[0:32]);
            if (gotId != wantId) revert InvalidWorkflowId(gotId, wantId);
        }
        if (wantOwner != address(0)) {
            address gotOwner = address(bytes20(metadata[42:62]));
            if (gotOwner != wantOwner) revert InvalidWorkflowOwner(gotOwner, wantOwner);
        }
    }
}
