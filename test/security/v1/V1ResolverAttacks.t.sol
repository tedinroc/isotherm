// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IsoTest} from "../../utils/IsoTest.sol";
import {Resolver} from "../../../src/Resolver.sol";
import {CollateralVault} from "../../../src/CollateralVault.sol";
import {OutcomeToken} from "../../../src/OutcomeToken.sol";
import {IIsothermResolver} from "../../../src/interfaces/IIsothermResolver.sol";

/// @notice v1 security diff review (2026-10-07): attacks on the NEW Resolver mechanics (challenge window, validUntil,
///         pause/stale interaction, role separation). Naming:
///           RESIDUAL_*  the attack still works against the deployed v1 code (documented, with severity in RESULT.md)
///           HOLDS_*     the v1 property holds under the attack (regression guard)
contract V1ResolverAttacksTest is IsoTest {
    bytes32 internal constant SRC = keccak256("iem+awc");
    uint256 internal constant EVIL_PK = 0xBAD;

    bytes32 internal id;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address internal thief = makeAddr("thief");

    function setUp() public override {
        super.setUp();
        id = _create(RCSS, D, 30);
        (yes, no) = _tokens(id);
        // Market state just before settlement: the true Tmax is 33, so YES (>= 30) is nearly certain.
        // alice holds 100 YES bought at ~0.98; the thief bought the 100 nearly-worthless NO for 0.02 each (2 AUSD).
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(thief, 100e6);
    }

    // ------------------------------------------------------------------------------------------------
    // Challenge window: what it does and does not contain (finding #7 follow-up)
    // ------------------------------------------------------------------------------------------------

    /// RESIDUAL (Medium, trust): a leaked attester key signs isVoid=true. A reported Void is final at once
    /// (finalAt = resolvedAt), so the guardian has nothing to challenge and the thief cashes the cheap side at 0.5
    /// in the same block. The challenge window only covers Settled results; the void path skips it entirely.
    function test_RESIDUAL_compromisedAttesterSignsVoid_finalInstantly_guardianCannotAct() public {
        vm.warp(RCSS_DAY_END + 2 hours); // 02:00 Taipei, the workflow's slot; nobody is watching
        _deliver(_reportVU(RCSS, D, 0, true, SRC, uint64(block.timestamp + 30 minutes)));

        IIsothermResolver.Result memory r = resolver.resultOf(RCSS, D);
        assertEq(uint8(r.status), uint8(IIsothermResolver.Status.Void));
        assertEq(r.finalAt, r.resolvedAt, "reported Void: no challenge window");
        assertTrue(resolver.isFinal(RCSS, D));

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Resolver.NotChallengeable.selector, RCSS, D));
        resolver.challenge(RCSS, D, keccak256("attester key compromised"));

        vm.prank(thief);
        uint256 paid = vault.redeem(id, 0, 100e6);
        assertEq(paid, 50e6, "thief: 2 AUSD of NO -> 50 AUSD, same block");
        vm.prank(alice);
        assertEq(vault.redeem(id, 100e6, 0), 50e6, "honest winner: 100 -> 50");
    }

    /// RESIDUAL (Medium, trust): even on the path the window DOES cover (a false Settled result), a successful
    /// guardian challenge turns the result into Void, and Void pays the cheap side 0.5. The thief who bought the
    /// losing side at 0.02 still makes 25x; the challenge only halves the gain (1.0 -> 0.5). "Contained" in
    /// test_FIXED_compromisedAttesterContainedByChallengeWindow means "capped at 0.5", not "no profit".
    function test_RESIDUAL_challengedFalseResultStillPaysTheThiefHalf() public {
        vm.warp(RCSS_DAY_END + 2 hours);
        _deliver(_reportVU(RCSS, D, 25, false, SRC, uint64(block.timestamp + 30 minutes))); // false: truth 33
        vm.warp(block.timestamp + CHALLENGE - 1);
        vm.prank(guardian);
        resolver.challenge(RCSS, D, keccak256("false Tmax"));
        vm.prank(thief);
        assertEq(vault.redeem(id, 0, 100e6), 50e6, "caught in time, thief still gets 0.5 per NO");
    }

    /// RESIDUAL (Low-Medium, ops): `pause()` is documented as the emergency stop for a suspected attester
    /// compromise, but it neither stops nor extends the challenge clock and the vault ignores the Resolver's pause.
    /// A guardian who pauses instead of challenging watches the false result become final and redeemable.
    function test_RESIDUAL_pauseDoesNotFreezeTheChallengeClockOrRedemption() public {
        vm.warp(RCSS_DAY_END + 2 hours);
        _deliver(_reportVU(RCSS, D, 25, false, SRC, uint64(block.timestamp + 30 minutes))); // false result
        vm.prank(guardian);
        resolver.pause(); // the "emergency stop"
        assertTrue(resolver.paused());
        vm.warp(resolver.resultOf(RCSS, D).finalAt);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Resolver.NotChallengeable.selector, RCSS, D));
        resolver.challenge(RCSS, D, keccak256("too late"));
        vm.prank(thief);
        assertEq(vault.redeem(id, 0, 100e6), 100e6, "false result paid in full while the Resolver is paused");
    }

    /// RESIDUAL (Medium, trust/ops): the owner is still the deployer key (the funding hot key used by scripts).
    /// With it an attacker disables the guardian, rotates the attester to its own key and voids or settles any
    /// pending ladder; no timelock, no second key.
    function test_RESIDUAL_ownerKeyAloneControlsEveryOutcome() public {
        address evil = vm.addr(EVIL_PK);
        vm.startPrank(owner);
        resolver.setGuardian(address(0)); // no challenges possible any more
        resolver.setAttester(evil);
        vm.stopPrank();
        vm.warp(RCSS_DAY_END);
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(EVIL_PK, resolver.settlementDigest(RCSS, D, 25, false, SRC, vu));
        _deliver(_encode(RCSS, D, 25, false, SRC, vu, sig));
        vm.prank(guardian);
        vm.expectRevert(Resolver.NotGuardian.selector);
        resolver.challenge(RCSS, D, 0);
        _finalize(RCSS, D);
        vm.prank(thief);
        assertEq(vault.redeem(id, 0, 100e6), 100e6, "owner-key holder picks the winner");
    }

    // ------------------------------------------------------------------------------------------------
    // validUntil (finding #9 follow-up)
    // ------------------------------------------------------------------------------------------------

    /// RESIDUAL (Low): the chain enforces only `now <= validUntil`; it does not cap the lifetime. An attestation
    /// signed with a long validUntil (bug, or a compromised signer) stays deliverable until the ladder resolves, so
    /// two conflicting signatures can coexist and whoever delivers first picks the outcome. The 30-minute TTL and
    /// "never sign a different outcome while an earlier one is live" are workflow-only rules.
    function test_RESIDUAL_validUntilLifetimeIsNotCappedOnChain() public {
        vm.warp(RCSS_DAY_END - 1); // run 1 signs VOID with a far expiry and is delivered 1 s early (rejected)
        bytes memory longVoid = _reportVU(RCSS, D, 0, true, SRC, type(uint64).max);
        vm.expectPartialRevert(Resolver.DayNotOver.selector);
        _deliver(longVoid);
        vm.warp(RCSS_DAY_END + 40 hours); // run 2 signs the correct 33; the NO side replays run 1 first
        bytes memory correct = _reportVU(RCSS, D, 33, false, SRC, uint64(block.timestamp + 30 minutes));
        _deliver(longVoid);
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void), "40 h old signature still valid");
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(correct);
    }

    // ------------------------------------------------------------------------------------------------
    // Boundaries and the pause/stale interaction (regression guards)
    // ------------------------------------------------------------------------------------------------

    /// HOLDS: there is no second (Monad: several blocks share one) in which both a guardian challenge and a
    /// redemption of the same Settled result can succeed: challenge needs now < finalAt, redeem needs now >= finalAt.
    function testFuzz_HOLDS_noSecondWhereChallengeAndRedeemBothSucceed(uint256 dt) public {
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 33, false, SRC));
        // half the runs sit within +-2 s of finalAt (the boundary is where a mutation would hide)
        dt = dt % 2 == 0 ? CHALLENGE - 2 + (dt / 2) % 5 : bound(dt, 0, 2 * CHALLENGE);
        vm.warp(RCSS_DAY_END + dt);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (bool redeemOk,) = address(vault).call(abi.encodeCall(CollateralVault.redeem, (id, 1e6, 0)));
        vm.revertToState(snap);
        vm.prank(guardian);
        (bool challengeOk,) = address(resolver).call(abi.encodeCall(Resolver.challenge, (RCSS, D, bytes32(0))));
        assertTrue(redeemOk != challengeOk, "exactly one of challenge / redeem is possible at any second");
        assertEq(redeemOk, dt >= CHALLENGE);
    }

    /// HOLDS (finding #2/#6 fixes under repeated pause/unpause): for any schedule of up to four pause/unpause
    /// toggles by the guardian and owner, voidIfStale
    ///   - never succeeds before dayEnd + 48h,
    ///   - never succeeds while paused or within 24h after an unpause, unless dayEnd + 7d has passed,
    ///   - always succeeds from dayEnd + 7d on (liveness), paused or not.
    function testFuzz_HOLDS_staleVoidScheduleUnderPauseToggles(uint256[4] memory toggles, uint8 n, uint256 tq) public {
        uint256 end = RCSS_DAY_END;
        uint256 hardMax = end + 7 days;
        uint256 t = end - 1 days;
        bool isPaused;
        uint256 lastUnpause;
        n = uint8(bound(n, 0, 4)); // even n ends unpaused (the resume-grace case), odd n ends paused
        for (uint256 i; i < n; ++i) {
            t += bound(toggles[i], 1, 3 days);
            vm.warp(t);
            if (!isPaused) {
                vm.prank(guardian);
                resolver.pause();
                isPaused = true;
            } else {
                vm.prank(owner);
                resolver.unpause();
                isPaused = false;
                lastUnpause = t;
            }
        }
        uint256 q = t + bound(tq, 0, 9 days);
        vm.warp(q);
        (bool ok,) = address(resolver).call(abi.encodeCall(Resolver.voidIfStale, (RCSS, D)));
        bool expect;
        if (q >= hardMax) expect = true;
        else if (isPaused) expect = false;
        else expect = q >= end + 48 hours && (lastUnpause == 0 || q >= lastUnpause + 24 hours);
        assertEq(ok, expect, "stale-void schedule");
        if (ok) assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
        assertGe(q >= end + 48 hours ? 1 : 0, ok ? 1 : 0, "never before dayEnd + 48h");
    }

    /// HOLDS: a report that was signed and delivered while the Resolver was paused fails (EnforcedPause) and, with
    /// the workflow's 30-minute validUntil, is dead by the time the owner unpauses; it cannot be replayed later.
    function test_HOLDS_reportRejectedDuringPauseExpiresBeforeUnpause() public {
        vm.prank(guardian);
        resolver.pause();
        vm.warp(RCSS_DAY_END + 2 hours);
        bytes memory rep = _reportVU(RCSS, D, 25, false, SRC, uint64(block.timestamp + 30 minutes));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deliver(rep);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(owner);
        resolver.unpause();
        vm.expectPartialRevert(Resolver.AttestationExpired.selector);
        _deliver(rep);
    }

    /// HOLDS: the guardian cannot pick a winner, cannot challenge a Void, cannot re-open a ladder and cannot
    /// challenge after finalAt; the attester cannot re-report after a challenge.
    function test_HOLDS_guardianPowersAreOnlyVoid() public {
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 33, false, SRC));
        vm.prank(guardian);
        resolver.challenge(RCSS, D, 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Resolver.NotChallengeable.selector, RCSS, D));
        resolver.challenge(RCSS, D, 0);
        bytes memory again = _report(RCSS, D, 25, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(again);
        vm.warp(RCSS_DAY_END + 7 days);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        resolver.voidIfStale(RCSS, D);
        vm.prank(guardian);
        vm.expectRevert(); // guardian has no admin rights
        resolver.setAttester(guardian);
    }
}
