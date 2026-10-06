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

/// @title Isotherm Resolver
/// @notice Chainlink CRE consumer that records the official daily maximum temperature (integer degC, METAR)
///         for a (station, local date) ladder. One result settles every strike of that city-date.
///
/// Trust model (read this before relying on a result):
///  - `onReport` only accepts calls from the configured `forwarder` (CRE KeystoneForwarder in production,
///    MockKeystoneForwarder for `cre workflow simulate --broadcast`).
///  - The MockKeystoneForwarder is PERMISSIONLESS (anyone can make it call us with any payload), so every report
///    must also carry an EIP-712 signature by `attester` over (station, date, tmaxC, isVoid, sourcesHash); the
///    EIP-712 domain binds chainId and this contract's address, so a signature cannot be replayed elsewhere.
///  - With the production forwarder, the owner may additionally pin the CRE workflow id / owner from `metadata`.
///    Attestation can only be switched off once a workflow id is pinned.
///  - Results are write-once: a (station, date) can be resolved exactly once (no double settle, no replay).
///  - A report is only accepted after the station-local day has ended.
///  - If no report arrives within STALE_WINDOW after the day ends, anyone may void the ladder (pays 0.5/0.5).
///    Voiding is never blocked by `pause`, so a paused or broken oracle cannot lock funds indefinitely.
contract Resolver is IReceiver, IIsothermResolver, EIP712, Ownable2Step, Pausable {
    struct StationConfig {
        int32 utcOffset; // seconds east of UTC, e.g. +28800 for Taipei (UTC+8)
        bool registered;
    }

    /// @notice EIP-712 struct signed by the attester. Domain: name "Isotherm Resolver", version "1".
    bytes32 public constant SETTLEMENT_TYPEHASH =
        keccak256("Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)");

    /// @notice Anyone may void a ladder this long after its local day ended if no report has arrived.
    uint256 public constant STALE_WINDOW = 24 hours;

    /// @notice Sanity bounds for a reported daily max (degC). World records are -89.2 and +56.7.
    int16 public constant MIN_TMAX_C = -90;
    int16 public constant MAX_TMAX_C = 70;

    address public forwarder;
    address public attester;
    address public guardian;
    bytes32 public expectedWorkflowId;
    address public expectedWorkflowOwner;
    bool public attestationRequired = true;

    mapping(bytes4 station => StationConfig) public stations;
    mapping(bytes4 station => mapping(uint32 date => Result)) private _results;

    event StationRegistered(bytes4 indexed station, int32 utcOffset);
    event ForwarderUpdated(address indexed previous, address indexed current);
    event AttesterUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowUpdated(bytes32 workflowId, address workflowOwner);
    event AttestationRequiredUpdated(bool required);
    event LadderResolved(
        bytes4 indexed station, uint32 indexed date, Status status, int16 tmaxC, bytes32 sourcesHash, address caller
    );

    error ZeroAddress();
    error InvalidSender(address sender, address expected);
    error InvalidMetadata();
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidWorkflowOwner(address received, address expected);
    error InvalidAttestation(address recovered);
    error UnknownStation(bytes4 station);
    error StationAlreadyRegistered(bytes4 station);
    error DayNotOver(bytes4 station, uint32 date, uint256 dayEnd);
    error NotStale(bytes4 station, uint32 date, uint256 staleAt);
    error AlreadyResolved(bytes4 station, uint32 date);
    error TmaxOutOfRange(int16 tmaxC);
    error NotGuardian();
    error WorkflowIdRequired();

    constructor(address owner_, address forwarder_, address attester_, address guardian_)
        EIP712("Isotherm Resolver", "1")
        Ownable(owner_)
    {
        if (forwarder_ == address(0) || attester_ == address(0)) revert ZeroAddress();
        forwarder = forwarder_;
        attester = attester_;
        guardian = guardian_;
        emit ForwarderUpdated(address(0), forwarder_);
        emit AttesterUpdated(address(0), attester_);
        emit GuardianUpdated(address(0), guardian_);
    }

    // ---------------------------------------------------------------------------------------------
    // CRE entrypoint
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev `report` = abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash,
    ///      bytes attestation), where attestation is a 65-byte ECDSA signature by `attester` over
    ///      `settlementDigest(station, date, tmaxC, isVoid, sourcesHash)`.
    function onReport(bytes calldata metadata, bytes calldata report) external whenNotPaused {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        _checkWorkflowMetadata(metadata);

        (bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, bytes memory attestation) =
            abi.decode(report, (bytes4, uint32, int16, bool, bytes32, bytes));

        if (attestationRequired) {
            address signer = ECDSA.recover(settlementDigest(station, date, tmaxC, isVoid, sourcesHash), attestation);
            if (signer != attester) revert InvalidAttestation(signer);
        }

        if (isVoid) {
            _resolve(station, date, Status.Void, 0, sourcesHash);
        } else {
            if (tmaxC < MIN_TMAX_C || tmaxC > MAX_TMAX_C) revert TmaxOutOfRange(tmaxC);
            _resolve(station, date, Status.Settled, tmaxC, sourcesHash);
        }
    }

    /// @notice Void a ladder whose day ended more than STALE_WINDOW ago without any report. Callable by anyone,
    ///         even while paused.
    function voidIfStale(bytes4 station, uint32 date) external {
        uint256 staleAt = dayEnd(station, date) + STALE_WINDOW;
        if (block.timestamp < staleAt) revert NotStale(station, date, staleAt);
        _resolve(station, date, Status.Void, 0, bytes32(0));
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

    /// @notice The EIP-712 digest the attester must sign for a report.
    function settlementDigest(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, station, date, tmaxC, isVoid, sourcesHash)));
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

    /// @dev Changing the forwarder always re-arms attestation. The workflow-id/owner pin is only meaningful behind a
    ///      forwarder that verifies DON signatures; behind the permissionless MockKeystoneForwarder the caller writes
    ///      the metadata (and the pinned id is public), so "attestation off" must be re-decided after every switch.
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert ZeroAddress();
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
        if (!attestationRequired) {
            attestationRequired = true;
            emit AttestationRequiredUpdated(true);
        }
    }

    function setAttester(address attester_) external onlyOwner {
        if (attester_ == address(0)) revert ZeroAddress();
        emit AttesterUpdated(attester, attester_);
        attester = attester_;
    }

    function setGuardian(address guardian_) external onlyOwner {
        emit GuardianUpdated(guardian, guardian_);
        guardian = guardian_;
    }

    /// @notice Pin the CRE workflow identity carried in `metadata` (production KeystoneForwarder only;
    ///         the MockKeystoneForwarder does not supply it). Zero values disable the respective check.
    function setExpectedWorkflow(bytes32 workflowId, address workflowOwner) external onlyOwner {
        if (!attestationRequired && workflowId == bytes32(0)) revert WorkflowIdRequired();
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        emit ExpectedWorkflowUpdated(workflowId, workflowOwner);
    }

    /// @notice Attestation can only be disabled while a workflow id is pinned.
    function setAttestationRequired(bool required) external onlyOwner {
        if (!required && expectedWorkflowId == bytes32(0)) revert WorkflowIdRequired();
        attestationRequired = required;
        emit AttestationRequiredUpdated(required);
    }

    /// @notice Emergency stop for `onReport` (e.g. suspected attester key compromise). Guardian or owner.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _resolve(bytes4 station, uint32 date, Status status, int16 tmaxC, bytes32 sourcesHash) internal {
        uint256 end = dayEnd(station, date); // reverts for unknown station / invalid date
        if (block.timestamp < end) revert DayNotOver(station, date, end);
        Result storage r = _results[station][date];
        if (r.status != Status.None) revert AlreadyResolved(station, date);
        r.status = status;
        r.tmaxC = tmaxC;
        r.resolvedAt = uint64(block.timestamp);
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
