// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {MockAUSD} from "./MockAUSD.sol";

/// @dev Shared fixture: Resolver + CollateralVault over a mock AUSD, stations RCSS (UTC+8) and RJTT (UTC+9),
///      clock at 2026-10-06 00:00:00 UTC, ladders for local date 2026-10-07, 15-minute challenge window.
abstract contract IsoTest is Test {
    bytes4 internal constant RCSS = "RCSS";
    bytes4 internal constant RJTT = "RJTT";
    uint32 internal constant D = 20261007;
    int32 internal constant TPE = 8 hours;
    int32 internal constant TYO = 9 hours;
    uint256 internal constant CHALLENGE = 15 minutes;

    uint256 internal constant T0 = 1_791_244_800; // 2026-10-06T00:00:00Z
    // RCSS 2026-10-07 local day = [2026-10-06T16:00Z, 2026-10-07T16:00Z)
    uint256 internal constant RCSS_DAY_END = 1_791_331_200 + 16 hours;
    uint256 internal constant RJTT_DAY_END = 1_791_331_200 + 15 hours;
    /// @dev Default attestation expiry used by helpers (far enough for every warp in the unit tests).
    uint64 internal constant VU = uint64(T0 + 365 days);

    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal attester;
    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal forwarder = makeAddr("forwarder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockAUSD internal ausd;
    Resolver internal resolver;
    CollateralVault internal vault;

    function setUp() public virtual {
        vm.warp(T0);
        attester = vm.addr(ATTESTER_PK);
        ausd = new MockAUSD();
        resolver = new Resolver(owner, forwarder, attester, guardian, CHALLENGE);
        vault = new CollateralVault(owner, resolver, ausd, guardian);
        vm.startPrank(owner);
        resolver.registerStation(RCSS, TPE);
        resolver.registerStation(RJTT, TYO);
        vault.setOperator(operator, true);
        vm.stopPrank();
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _create(bytes4 station, uint32 date, int16 strike) internal returns (bytes32 id) {
        uint64 close = uint64(resolver.dayEnd(station, date) - 1 hours);
        vm.prank(operator);
        id = vault.createSeries(station, date, strike, close);
    }

    function _tokens(bytes32 id) internal view returns (OutcomeToken yes, OutcomeToken no) {
        StrikeFactory.Series memory s = vault.getSeries(id);
        return (s.yes, s.no);
    }

    function _fund(address who, uint256 amount) internal {
        ausd.mint(who, amount);
        vm.prank(who);
        ausd.approve(address(vault), type(uint256).max);
    }

    function _mint(address who, bytes32 id, uint256 amount) internal {
        _fund(who, amount);
        vm.prank(who);
        vault.mintSet(id, amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The attester's EIP-712 digest with the default expiry VU.
    function _digest(bytes4 station, uint32 date, int16 tmax, bool isVoid, bytes32 src) internal view returns (bytes32) {
        return resolver.settlementDigest(station, date, tmax, isVoid, src, VU);
    }

    /// @dev Final report encoding: abi.encode(station, date, tmaxC, isVoid, sourcesHash, validUntil, signature).
    function _encode(bytes4 station, uint32 date, int16 tmax, bool isVoid, bytes32 src, uint64 validUntil, bytes memory sig)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(station, date, tmax, isVoid, src, validUntil, sig);
    }

    function _reportVU(bytes4 station, uint32 date, int16 tmax, bool isVoid, bytes32 src, uint64 validUntil)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig =
            _sign(ATTESTER_PK, resolver.settlementDigest(station, date, tmax, isVoid, src, validUntil));
        return _encode(station, date, tmax, isVoid, src, validUntil, sig);
    }

    function _report(bytes4 station, uint32 date, int16 tmax, bool isVoid, bytes32 src)
        internal
        view
        returns (bytes memory)
    {
        return _reportVU(station, date, tmax, isVoid, src, VU);
    }

    function _deliver(bytes memory report) internal {
        vm.prank(forwarder);
        resolver.onReport(new bytes(64), report);
    }

    /// @dev Deliver a Settled report (at dayEnd if earlier) and move past the challenge window so it is final.
    function _settle(bytes4 station, uint32 date, int16 tmax) internal {
        if (block.timestamp < resolver.dayEnd(station, date)) vm.warp(resolver.dayEnd(station, date));
        _deliver(_report(station, date, tmax, false, keccak256("sources")));
        _finalize(station, date);
    }

    /// @dev Warp to the result's finalAt (no-op if already final).
    function _finalize(bytes4 station, uint32 date) internal {
        uint64 f = resolver.resultOf(station, date).finalAt;
        if (block.timestamp < f) vm.warp(f);
    }

    function _status(bytes4 station, uint32 date) internal view returns (IIsothermResolver.Status) {
        return resolver.resultOf(station, date).status;
    }
}
