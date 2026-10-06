// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IsoTest} from "../utils/IsoTest.sol";
import {Resolver} from "../../src/Resolver.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {PermissionlessForwarder, RawReport} from "./SecUtils.sol";

/// @notice Settlement-spoofing attempts against the Resolver: signature malleability, replay across
///         contracts / chains / stations / dates, non-canonical ABI, Monad same-second blocks, the void path,
///         guardian powers, and the "attestation off behind a permissionless forwarder" misconfiguration.
contract ResolverAttacksTest is IsoTest {
    bytes32 internal constant SRC = keccak256("sources");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ------------------------------------------------------------------------------------------------
    // Signature malleability
    // ------------------------------------------------------------------------------------------------

    /// The (r, n-s, v^1) twin is a valid secp256k1 signature by the same key (raw ecrecover accepts it), the
    /// EIP-2098 64-byte form encodes the same signature: OZ ECDSA rejects both. Malleability is moot anyway
    /// because results are write-once per (station, date), not per signature.
    function test_malleableTwinAndCompactSignatureRejected() public {
        vm.warp(RCSS_DAY_END);
        bytes32 digest = resolver.settlementDigest(RCSS, D, 31, false, SRC);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, vFlip, r, sHigh), attester, "twin is a valid raw signature");

        bytes memory rep = abi.encode(RCSS, D, int16(31), false, SRC, abi.encodePacked(r, sHigh, vFlip));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, sHigh));
        _deliver(rep);

        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        rep = abi.encode(RCSS, D, int16(31), false, SRC, abi.encodePacked(r, vs));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        _deliver(rep);

        rep = abi.encode(RCSS, D, int16(31), false, SRC, abi.encodePacked(r, s, v));
        _deliver(rep);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(rep);
    }

    // ------------------------------------------------------------------------------------------------
    // Replay
    // ------------------------------------------------------------------------------------------------

    function test_replayOnAnotherResolverSameChainSameAttester() public {
        Resolver other = new Resolver(owner, forwarder, attester, guardian);
        vm.prank(owner);
        other.registerStation(RCSS, TPE);
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC); // signed for `resolver`
        vm.prank(forwarder);
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        other.onReport(new bytes(64), rep);
    }

    function test_replayOnAnotherChain() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC); // chainid 31337
        vm.chainId(10143);
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(rep);
        vm.chainId(143); // Monad mainnet
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(rep);
    }

    /// Mutating any single signed field (station, date, tmax, isVoid, sourcesHash) under a valid signature fails.
    function testFuzz_anySingleFieldMutationRejected(uint8 which, uint256 seed) public {
        vm.warp(RCSS_DAY_END + 2 days);
        bytes memory sig = _sign(ATTESTER_PK, resolver.settlementDigest(RCSS, D, 31, false, SRC));
        bytes4 st = RCSS;
        uint32 dt = D;
        int16 t = 31;
        bool isV;
        bytes32 src = SRC;
        which %= 5;
        if (which == 0) {
            st = RJTT;
        } else if (which == 1) {
            dt = seed % 2 == 0 ? 20261006 : 20261008;
        } else if (which == 2) {
            t = int16(int256(bound(seed, 0, 160)) - 90);
            if (t == 31) t = 32;
        } else if (which == 3) {
            isV = true;
        } else {
            src = keccak256(abi.encode(seed, "other sources"));
        }
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(abi.encode(st, dt, t, isV, src, sig));
        assertEq(uint8(_status(st, dt)), 0);
    }

    /// Dirty high bits in bool / int16 / bytes4 words are rejected by the ABI decoder before any signature check,
    /// so the decoded (signed) values can never differ from what an off-chain indexer reads from calldata.
    function test_nonCanonicalAbiRejected() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        bytes memory dirtyBool = bytes.concat(rep);
        bytes memory dirtyInt = bytes.concat(rep);
        bytes memory dirtyB4 = bytes.concat(rep);
        assembly ("memory-safe") {
            mstore(add(dirtyBool, 0x80), 2) // word 3: isVoid = 2
            mstore(add(dirtyInt, 0x60), or(31, shl(16, 1))) // word 2: int16 31 with bit 16 set
            mstore(add(dirtyB4, 0x20), or(shl(224, 0x52435353), 1)) // word 0: "RCSS" + dirty low byte
        }
        bytes[3] memory bad = [dirtyBool, dirtyInt, dirtyB4];
        for (uint256 i; i < 3; ++i) {
            vm.prank(forwarder);
            vm.expectRevert();
            resolver.onReport(new bytes(64), bad[i]);
        }
        assertEq(uint8(_status(RCSS, D)), 0);
        _deliver(rep);
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 31);
    }

    // ------------------------------------------------------------------------------------------------
    // Monad: ~3 blocks share each 1-second TIMESTAMP
    // ------------------------------------------------------------------------------------------------

    function test_monadSameSecondBlocksAtDayEndBoundary() public {
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.warp(RCSS_DAY_END - 1);
        for (uint256 i; i < 3; ++i) {
            vm.roll(block.number + 1); // new block, same second
            vm.expectRevert(abi.encodeWithSelector(Resolver.DayNotOver.selector, RCSS, D, RCSS_DAY_END));
            _deliver(rep);
        }
        vm.warp(RCSS_DAY_END);
        vm.roll(block.number + 1);
        _deliver(rep);
        for (uint256 i; i < 2; ++i) {
            vm.roll(block.number + 1);
            vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
            _deliver(rep);
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Void path
    // ------------------------------------------------------------------------------------------------

    /// FINDING (Medium): voidIfStale is a free option for the losing side. If the honest report is late by
    /// STALE_WINDOW (24h) - e.g. IEM outage (158 days on RCSS in 2025-26), missed cron, Mac asleep, CRE login
    /// expired - the NO holder voids first in the same second and turns a 0 payout into 0.5. The weather spec's
    /// own void deadline is 36h after the day ends, so between 24h and 36h the oracle may still be retrying.
    function test_staleVoidLetsLosingSideFrontRunALateReport() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(bob, 100e6); // alice = YES holder, bob = NO holder
        assertEq(yes.balanceOf(alice), 100e6);

        vm.warp(RCSS_DAY_END + resolver.STALE_WINDOW()); // the late but correct report is pending: Tmax 31 >= 30
        bytes memory late = _report(RCSS, D, 31, false, SRC);
        vm.prank(bob);
        resolver.voidIfStale(RCSS, D); // same second, ordered first
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(late);

        vm.prank(alice);
        uint256 a = vault.redeem(id, 100e6, 0);
        vm.prank(bob);
        uint256 b = vault.redeem(id, 0, 100e6);
        assertEq(a, 50e6, "winner gets 0.5 instead of 1");
        assertEq(b, 50e6, "loser gets 0.5 instead of 0");
    }

    /// FINDING (Medium, privileged): the guardian alone can turn ANY outcome into a void. Pause blocks onReport,
    /// voidIfStale ignores pause, and unpause is owner-only and cannot undo the void.
    function test_guardianPauseCanForceVoidOnAnyLadder() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        vm.warp(RCSS_DAY_END + 2 hours);
        bytes memory honest = _report(RCSS, D, 31, false, SRC);
        vm.prank(guardian);
        resolver.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deliver(honest);
        vm.warp(RCSS_DAY_END + 24 hours);
        vm.prank(guardian);
        resolver.voidIfStale(RCSS, D);
        vm.prank(owner);
        resolver.unpause();
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(honest);
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
    }

    /// FINDING (Low): attestations are bearer instruments with no expiry/nonce. A report whose delivery failed
    /// (here: sent 1 s before dayEnd, as can happen when several Monad blocks share a second or a clock is
    /// skewed; equally an out-of-gas delivery under a tight Monad gas limit) stays valid in public calldata.
    /// If the workflow later signs a DIFFERENT outcome (sources caught up), whoever benefits picks which lands.
    function test_failedDeliveryLeavesAValidAttestationThatCanRaceANewerOne() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        vm.prank(owner);
        resolver.setForwarder(address(mock));
        bytes32 id = _create(RCSS, D, 29);
        (, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(bob, 100e6);

        // run 1: IEM lagging -> sources disagree -> workflow signs VOID; delivered 1 s early -> rejected but public
        vm.warp(RCSS_DAY_END - 1);
        bytes memory run1 = RawReport.build(keccak256("exec1"), bytes32(0), address(0), _report(RCSS, D, 0, true, SRC));
        vm.prank(makeAddr("creTransmitter"));
        assertFalse(mock.report(address(resolver), run1, "", new bytes[](0)), "run 1 failed on-chain");

        // run 2 an hour later: sources agree on 29 -> workflow signs SETTLED 29 (YES >= 29 wins)
        vm.warp(RCSS_DAY_END + 1 hours);
        bytes memory run2 =
            RawReport.build(keccak256("exec2"), bytes32(0), address(0), _report(RCSS, D, 29, false, SRC));

        // bob (NO holder) copies run 1's calldata and lands it first
        vm.prank(bob);
        assertTrue(mock.report(address(resolver), run1, "", new bytes[](0)), "stale VOID accepted");
        vm.prank(makeAddr("creTransmitter"));
        assertFalse(mock.report(address(resolver), run2, "", new bytes[](0)), "correct report now rejected");
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
    }

    // ------------------------------------------------------------------------------------------------
    // Forwarder / attestation configuration
    // ------------------------------------------------------------------------------------------------

    /// FIXED in src/Resolver.sol (setForwarder re-arms attestation). Before the fix: owner moves to the production
    /// forwarder, pins the workflow and disables attestation (the documented CRE go-live steps), later points back
    /// at the permissionless mock for a `cre workflow simulate --broadcast` demo -> anyone reads
    /// expectedWorkflowId()/expectedWorkflowOwner(), writes them into the header and settles any ladder unsigned.
    function test_FIXED_switchingBackToMockForwarderRearmsAttestation() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        bytes32 wf = keccak256("isotherm-settle");
        address wfOwner = makeAddr("wfOwner");
        vm.startPrank(owner);
        resolver.setForwarder(makeAddr("keystoneForwarder"));
        resolver.setExpectedWorkflow(wf, wfOwner);
        resolver.setAttestationRequired(false);
        assertFalse(resolver.attestationRequired());
        vm.expectEmit(address(resolver));
        emit Resolver.AttestationRequiredUpdated(true);
        resolver.setForwarder(address(mock));
        vm.stopPrank();
        assertTrue(resolver.attestationRequired(), "attestation re-armed by the forwarder switch");

        vm.warp(RCSS_DAY_END);
        bytes memory forged = abi.encode(RCSS, D, int16(70), false, bytes32(0), bytes(""));
        bytes memory raw =
            RawReport.build(keccak256("x"), resolver.expectedWorkflowId(), resolver.expectedWorkflowOwner(), forged);
        vm.prank(makeAddr("attacker"));
        assertFalse(mock.report(address(resolver), raw, "", new bytes[](0)), "forged report rejected");
        assertEq(uint8(_status(RCSS, D)), 0);
    }

    /// RESIDUAL owner footgun (documented, not fixable without trusting a forwarder whitelist): if attestation is
    /// disabled while the forwarder is STILL the permissionless mock (wrong order of the go-live steps), the
    /// workflow pin is meaningless and anyone settles any ladder. This test passes because the exploit works.
    function test_RESIDUAL_attestationOffBehindPermissionlessForwarderIsExploitable() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        vm.startPrank(owner);
        resolver.setForwarder(address(mock));
        resolver.setExpectedWorkflow(keccak256("isotherm-settle"), makeAddr("wfOwner"));
        resolver.setAttestationRequired(false); // should only ever follow setForwarder(production KeystoneForwarder)
        vm.stopPrank();

        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        vm.warp(RCSS_DAY_END);
        bytes memory forged = abi.encode(RCSS, D, int16(70), false, bytes32(0), bytes(""));
        bytes memory raw =
            RawReport.build(keccak256("x"), resolver.expectedWorkflowId(), resolver.expectedWorkflowOwner(), forged);
        vm.prank(makeAddr("attacker"));
        assertTrue(mock.report(address(resolver), raw, "", new bytes[](0)), "unsigned forged report accepted");
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 70, "attacker chose the outcome");
    }

    /// The metadata pin is also meaningless WITH attestation on (defence in depth only): the attestation is what
    /// protects the mock path. Forged metadata + unsigned report is rejected because the signature is missing.
    function test_mockForwarderMetadataIsCallerControlled() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        vm.startPrank(owner);
        resolver.setForwarder(address(mock));
        resolver.setExpectedWorkflow(keccak256("isotherm-settle"), makeAddr("wfOwner"));
        vm.stopPrank();
        vm.warp(RCSS_DAY_END);
        bytes memory raw = RawReport.build(
            keccak256("x"),
            resolver.expectedWorkflowId(),
            resolver.expectedWorkflowOwner(),
            abi.encode(RCSS, D, int16(70), false, bytes32(0), bytes(""))
        );
        vm.prank(makeAddr("attacker"));
        assertFalse(mock.report(address(resolver), raw, "", new bytes[](0)));
        // the same header with a real attestation goes through: the pin did not stop anything by itself
        raw = RawReport.build(
            keccak256("y"),
            resolver.expectedWorkflowId(),
            resolver.expectedWorkflowOwner(),
            _report(RCSS, D, 31, false, SRC)
        );
        vm.prank(makeAddr("anyone"));
        assertTrue(mock.report(address(resolver), raw, "", new bytes[](0)));
    }
}
