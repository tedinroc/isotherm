// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IsoTest} from "../utils/IsoTest.sol";
import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {PermissionlessForwarder, RawReport} from "./SecUtils.sol";

/// @notice Settlement-spoofing attempts against the Resolver: signature malleability, replay across
///         contracts / chains / stations / dates / expiries, non-canonical ABI, Monad same-second blocks, the void
///         path, guardian powers, and the forwarder configuration. Tests named FIXED_* reproduce a security-review
///         finding against the v1 code and assert the exploit no longer works.
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
        bytes32 digest = _digest(RCSS, D, 31, false, SRC);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, vFlip, r, sHigh), attester, "twin is a valid raw signature");

        bytes memory rep = _encode(RCSS, D, 31, false, SRC, VU, abi.encodePacked(r, sHigh, vFlip));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, sHigh));
        _deliver(rep);

        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        rep = _encode(RCSS, D, 31, false, SRC, VU, abi.encodePacked(r, vs));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        _deliver(rep);

        rep = _encode(RCSS, D, 31, false, SRC, VU, abi.encodePacked(r, s, v));
        _deliver(rep);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(rep);
    }

    // ------------------------------------------------------------------------------------------------
    // Replay
    // ------------------------------------------------------------------------------------------------

    function test_replayOnAnotherResolverSameChainSameAttester() public {
        Resolver other = new Resolver(owner, forwarder, attester, guardian, CHALLENGE);
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

    /// Mutating any single signed field (station, date, tmax, isVoid, sourcesHash, validUntil) under a valid signature
    /// fails.
    function testFuzz_anySingleFieldMutationRejected(uint8 which, uint256 seed) public {
        vm.warp(RCSS_DAY_END + 2 days);
        bytes memory sig = _sign(ATTESTER_PK, _digest(RCSS, D, 31, false, SRC));
        bytes4 st = RCSS;
        uint32 dt = D;
        int16 t = 31;
        bool isV;
        bytes32 src = SRC;
        uint64 vu = VU;
        which %= 6;
        if (which == 0) {
            st = RJTT;
        } else if (which == 1) {
            dt = seed % 2 == 0 ? 20261006 : 20261008;
        } else if (which == 2) {
            t = int16(int256(bound(seed, 0, 160)) - 90);
            if (t == 31) t = 32;
        } else if (which == 3) {
            isV = true;
        } else if (which == 4) {
            src = keccak256(abi.encode(seed, "other sources"));
        } else {
            vu = uint64(bound(seed, block.timestamp, type(uint64).max));
            if (vu == VU) vu = VU + 1;
        }
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(_encode(st, dt, t, isV, src, vu, sig));
        assertEq(uint8(_status(st, dt)), 0);
    }

    /// Dirty high bits in bool / int16 / bytes4 / uint64 words are rejected by the ABI decoder before any signature
    /// check, so the decoded (signed) values can never differ from what an off-chain indexer reads from calldata.
    function test_nonCanonicalAbiRejected() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        bytes memory dirtyBool = bytes.concat(rep);
        bytes memory dirtyInt = bytes.concat(rep);
        bytes memory dirtyB4 = bytes.concat(rep);
        bytes memory dirtyU64 = bytes.concat(rep);
        uint256 vu = VU;
        assembly ("memory-safe") {
            mstore(add(dirtyBool, 0x80), 2) // word 3: isVoid = 2
            mstore(add(dirtyInt, 0x60), or(31, shl(16, 1))) // word 2: int16 31 with bit 16 set
            mstore(add(dirtyB4, 0x20), or(shl(224, 0x52435353), 1)) // word 0: "RCSS" + dirty low byte
            mstore(add(dirtyU64, 0xc0), or(vu, shl(64, 1))) // word 5: validUntil with bit 64 set
        }
        bytes[4] memory bad = [dirtyBool, dirtyInt, dirtyB4, dirtyU64];
        for (uint256 i; i < 4; ++i) {
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
    // Void path (security review findings #2, #6) - FIXED in v1
    // ------------------------------------------------------------------------------------------------

    /// FIXED (was Medium #2): the stale window (48h) now covers the workflow's own void deadline (36h) plus 12h of
    /// margin, so a late-but-correct report inside that window cannot be front-run by the losing side's stale void.
    function test_FIXED_staleVoidCannotFrontRunAReportWithinWorkflowDeadline() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(bob, 100e6); // alice = YES holder, bob = NO holder
        assertEq(yes.balanceOf(alice), 100e6);

        vm.warp(RCSS_DAY_END + 36 hours); // the workflow's last chance (IEM lag / outage); Tmax 31 >= 30
        bytes memory late = _reportVU(RCSS, D, 31, false, SRC, uint64(block.timestamp + 30 minutes));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Resolver.NotStale.selector, RCSS, D, RCSS_DAY_END + 48 hours));
        resolver.voidIfStale(RCSS, D); // bob tries to void first: too early
        _deliver(late);
        _finalize(RCSS, D);

        vm.prank(alice);
        assertEq(vault.redeem(id, 100e6, 0), 100e6, "winner gets 1");
        vm.prank(bob);
        assertEq(vault.redeem(id, 0, 100e6), 0, "loser gets 0");
    }

    /// FIXED (was Medium #6): pausing no longer lets the guardian force a void through voidIfStale. While paused the
    /// stale void is blocked; after the owner unpauses, the workflow gets 24h to deliver first.
    function test_FIXED_guardianPauseCannotForceStaleVoid() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        vm.warp(RCSS_DAY_END + 2 hours);
        vm.prank(guardian);
        resolver.pause();
        bytes memory honest = _report(RCSS, D, 31, false, SRC);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deliver(honest);
        vm.warp(RCSS_DAY_END + 48 hours);
        vm.prank(guardian);
        vm.expectPartialRevert(Resolver.NotStale.selector);
        resolver.voidIfStale(RCSS, D); // the old exploit: now refused while paused
        vm.warp(RCSS_DAY_END + 72 hours);
        vm.prank(owner);
        resolver.unpause();
        vm.prank(guardian);
        vm.expectPartialRevert(Resolver.NotStale.selector);
        resolver.voidIfStale(RCSS, D); // and refused during the resume grace
        _deliver(_reportVU(RCSS, D, 31, false, SRC, uint64(block.timestamp + 1 hours)));
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Settled));
    }

    /// FIXED (was Low #9): attestations expire. A report whose delivery failed (sent 1 s before dayEnd) can no longer
    /// be replayed by the side that benefits once the workflow has signed a newer outcome after the expiry.
    function test_FIXED_expiredAttestationCannotRaceANewerOne() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        vm.prank(owner);
        resolver.setForwarder(address(mock));
        bytes32 id = _create(RCSS, D, 29);
        (, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(bob, 100e6);

        // run 1: sources disagree -> workflow signs VOID valid for 30 min; delivered 1 s early -> rejected but public
        vm.warp(RCSS_DAY_END - 1);
        bytes memory p1 = _reportVU(RCSS, D, 0, true, SRC, uint64(block.timestamp + 30 minutes));
        bytes memory run1 = RawReport.build(keccak256("exec1"), bytes32(0), address(0), p1);
        vm.prank(makeAddr("creTransmitter"));
        assertFalse(mock.report(address(resolver), run1, "", new bytes[](0)), "run 1 failed on-chain");

        // run 2 an hour later (after run 1 expired): sources agree on 29 -> workflow signs SETTLED 29
        vm.warp(RCSS_DAY_END + 1 hours);
        bytes memory p2 = _reportVU(RCSS, D, 29, false, SRC, uint64(block.timestamp + 30 minutes));
        bytes memory run2 = RawReport.build(keccak256("exec2"), bytes32(0), address(0), p2);

        // bob (NO holder) copies run 1's calldata and lands it first: rejected as expired
        vm.prank(bob);
        assertFalse(mock.report(address(resolver), run1, "", new bytes[](0)), "stale VOID rejected (expired)");
        vm.prank(makeAddr("creTransmitter"));
        assertTrue(mock.report(address(resolver), run2, "", new bytes[](0)), "correct report lands");
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 29);
    }

    /// FIXED (was Medium #7): a leaked attester key is contained by the challenge window. The attacker signs a false
    /// outcome and holds the "winning" side, but redemption only opens at finalAt; the guardian voids it first.
    function test_FIXED_compromisedAttesterContainedByChallengeWindow() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        address thief = makeAddr("thief");
        _mint(alice, id, 100e6);
        vm.prank(alice);
        yes.transfer(thief, 100e6); // thief bought the (really losing) YES cheaply
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 35, false, SRC)); // signed with the stolen attester key; truth was 25
        vm.prank(thief);
        vm.expectPartialRevert(CollateralVault.NotFinal.selector);
        vault.redeem(id, 100e6, 0); // cannot cash out inside the window
        vm.warp(RCSS_DAY_END + 10 minutes);
        vm.prank(guardian);
        resolver.challenge(RCSS, D, keccak256("attester key compromised"));
        vm.prank(thief);
        assertEq(vault.redeem(id, 100e6, 0), 50e6, "void: the thief gets 0.5, not 1");
        vm.prank(alice);
        assertEq(vault.redeem(id, 0, 100e6), 50e6);
        assertEq(no.totalSupply(), 0);
    }

    /// RESIDUAL (documented trust): the guardian can veto ANY settled result to void inside the window (it cannot
    /// pick a winner). This is the price of the compromise containment above; use a separate guardian key.
    function test_RESIDUAL_guardianCanVoidAnHonestResultInsideTheWindow() public {
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 31, false, SRC));
        vm.prank(guardian);
        resolver.challenge(RCSS, D, bytes32(0));
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
    }

    // ------------------------------------------------------------------------------------------------
    // Forwarder / attestation configuration (security review finding #1) - FIXED in v1
    // ------------------------------------------------------------------------------------------------

    /// FIXED: attestation can never be switched off, so the "attestation off behind a permissionless forwarder"
    /// footgun no longer exists in any order of go-live steps. Even with the workflow id/owner pinned and copied into
    /// the mock's caller-written header, an unsigned report is rejected.
    function test_FIXED_unsignedReportRejectedWhateverTheForwarderConfig() public {
        PermissionlessForwarder mock = new PermissionlessForwarder();
        bytes32 wf = keccak256("isotherm-settle");
        address wfOwner = makeAddr("wfOwner");
        vm.startPrank(owner);
        resolver.setForwarder(makeAddr("keystoneForwarder"));
        resolver.setExpectedWorkflow(wf, wfOwner);
        resolver.setForwarder(address(mock)); // back to the mock for a `cre workflow simulate --broadcast` demo
        vm.stopPrank();
        (bool ok,) = address(resolver).call(abi.encodeWithSignature("setAttestationRequired(bool)", false));
        assertFalse(ok, "no toggle");

        vm.warp(RCSS_DAY_END);
        bytes memory forged = _encode(RCSS, D, 70, false, bytes32(0), VU, bytes(""));
        bytes memory raw =
            RawReport.build(keccak256("x"), resolver.expectedWorkflowId(), resolver.expectedWorkflowOwner(), forged);
        vm.prank(makeAddr("attacker"));
        assertFalse(mock.report(address(resolver), raw, "", new bytes[](0)), "forged report rejected");
        assertEq(uint8(_status(RCSS, D)), 0);
    }

    /// The metadata pin is meaningless behind the mock (caller-controlled header); the attestation is what protects
    /// the mock path. Forged metadata + unsigned report is rejected; the same header with a real attestation passes.
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
            _encode(RCSS, D, 70, false, bytes32(0), VU, bytes(""))
        );
        vm.prank(makeAddr("attacker"));
        assertFalse(mock.report(address(resolver), raw, "", new bytes[](0)));
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
