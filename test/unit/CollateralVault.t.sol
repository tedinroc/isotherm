// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IsoTest} from "../utils/IsoTest.sol";
import {Mock18} from "../utils/MockAUSD.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {Resolver} from "../../src/Resolver.sol";
import {StationTime} from "../../src/lib/StationTime.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {FeeToken} from "../security/SecUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract CollateralVaultTest is IsoTest {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event SeriesCreated(
        bytes32 indexed seriesId,
        bytes4 indexed station,
        uint32 indexed date,
        int16 strikeC,
        uint64 closeTime,
        address yes,
        address no
    );
    event Redeemed(
        bytes32 indexed seriesId, address indexed account, uint256 yesAmount, uint256 noAmount, uint256 payout
    );

    // --- construction ------------------------------------------------------------------------------

    function test_constructorRequires6Decimals() public {
        Mock18 e18 = new Mock18();
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.CollateralDecimalsMismatch.selector, uint8(18)));
        new CollateralVault(owner, resolver, e18, guardian);
    }

    // --- series creation ---------------------------------------------------------------------------

    function test_createSeries() public {
        uint64 close = uint64(RCSS_DAY_END - 2 hours);
        bytes32 expectedId = vault.seriesIdOf(RCSS, D, 30);
        address py = vault.predictTokenAddress(RCSS, D, 30, true);
        address pn = vault.predictTokenAddress(RCSS, D, 30, false);
        vm.expectEmit(address(vault));
        emit SeriesCreated(expectedId, RCSS, D, 30, close, py, pn);
        vm.prank(operator);
        bytes32 id = vault.createSeries(RCSS, D, 30, close);
        assertEq(id, expectedId);
        StrikeFactory.Series memory s = vault.getSeries(id);
        assertEq(s.station, RCSS);
        assertEq(s.date, D);
        assertEq(s.strikeC, 30);
        assertEq(s.closeTime, close);
        assertEq(address(s.yes), py);
        assertEq(address(s.no), pn);
        assertEq(s.collateral, 0);
        assertEq(vault.ladderCount(), 1);
        StrikeFactory.LadderRef memory l = vault.ladderAt(0);
        assertEq(l.station, RCSS);
        assertEq(l.date, D);
    }

    function test_createSeriesAccessControl() public {
        vm.prank(alice);
        vm.expectRevert(StrikeFactory.NotOperator.selector);
        vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END));
        vm.prank(owner); // owner is implicitly an operator
        vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END));
        vm.prank(owner);
        vault.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(StrikeFactory.NotOperator.selector);
        vault.createSeries(RCSS, D, 31, uint64(RCSS_DAY_END));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setOperator(alice, true);
    }

    function test_createSeriesValidation() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Resolver.UnknownStation.selector, bytes4("ZGSZ")));
        vault.createSeries("ZGSZ", D, 30, uint64(RCSS_DAY_END));
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidDate.selector, uint32(20261131)));
        vault.createSeries(RCSS, 20261131, 30, uint64(RCSS_DAY_END));
        // closeTime must be in the future and no later than the end of the local observation day
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.BadCloseTime.selector, uint64(T0), RCSS_DAY_END));
        vault.createSeries(RCSS, D, 30, uint64(T0));
        vm.expectRevert(
            abi.encodeWithSelector(StrikeFactory.BadCloseTime.selector, uint64(RCSS_DAY_END + 1), RCSS_DAY_END)
        );
        vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END + 1));
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.StrikeOutOfRange.selector, int16(71)));
        vault.createSeries(RCSS, D, 71, uint64(RCSS_DAY_END));
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.StrikeOutOfRange.selector, int16(-91)));
        vault.createSeries(RCSS, D, -91, uint64(RCSS_DAY_END));
        bytes32 id = vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END)); // closeTime == dayEnd is allowed
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.SeriesExists.selector, id));
        vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END - 5 hours));
        vm.stopPrank();
    }

    function test_createLadder() public {
        int16[] memory ks = new int16[](6);
        for (uint256 i; i < 6; ++i) {
            ks[i] = int16(int256(28 + i));
        }
        vm.prank(operator);
        bytes32[] memory ids = vault.createLadder(RCSS, D, ks, uint64(RCSS_DAY_END - 1 hours));
        assertEq(ids.length, 6);
        bytes32[] memory listed = vault.ladderSeries(RCSS, D);
        assertEq(listed.length, 6);
        for (uint256 i; i < 6; ++i) {
            assertEq(listed[i], ids[i]);
            assertEq(vault.getSeries(ids[i]).strikeC, ks[i]);
        }
        assertEq(vault.ladderCount(), 1);
        // extending the same ladder later does not create a new ladder entry
        _create(RCSS, D, 34);
        assertEq(vault.ladderCount(), 1);
        assertEq(vault.ladderSeries(RCSS, D).length, 7);

        vm.prank(operator);
        vm.expectRevert(StrikeFactory.EmptyLadder.selector);
        vault.createLadder(RJTT, D, new int16[](0), uint64(RJTT_DAY_END));
        int16[] memory dup = new int16[](2);
        dup[0] = 20;
        dup[1] = 20;
        bytes32 dupId = vault.seriesIdOf(RJTT, D, 20);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.SeriesExists.selector, dupId));
        vault.createLadder(RJTT, D, dup, uint64(RJTT_DAY_END));
    }

    // --- minting -----------------------------------------------------------------------------------

    function test_mintSet() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        assertEq(yes.balanceOf(alice), 100e6);
        assertEq(no.balanceOf(alice), 100e6);
        assertEq(ausd.balanceOf(address(vault)), 100e6);
        assertEq(ausd.balanceOf(alice), 0);
        assertEq(vault.getSeries(id).collateral, 100e6);
    }

    function test_mintSetTo() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _fund(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(CollateralVault.ZeroAddress.selector);
        vault.mintSetTo(id, 10e6, address(0));
        vm.prank(alice);
        vault.mintSetTo(id, 10e6, bob);
        assertEq(yes.balanceOf(bob), 10e6);
        assertEq(no.balanceOf(bob), 10e6);
        assertEq(yes.balanceOf(alice), 0);
    }

    function test_mintSetReverts() public {
        bytes32 id = _create(RCSS, D, 30);
        _fund(alice, 10e6);
        vm.startPrank(alice);
        vm.expectRevert(CollateralVault.ZeroAmount.selector);
        vault.mintSet(id, 0);
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.UnknownSeries.selector, bytes32(uint256(7))));
        vault.mintSet(bytes32(uint256(7)), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10e6, 11e6));
        vault.mintSet(id, 11e6);
        vm.stopPrank();

        uint64 close = vault.getSeries(id).closeTime;
        vm.warp(close);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.MintClosed.selector, id, close));
        vault.mintSet(id, 1e6);
    }

    function test_pauseStopsMintingOnly() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 10e6);
        vm.prank(alice);
        vm.expectRevert(CollateralVault.NotGuardian.selector);
        vault.pause();
        vm.prank(guardian);
        vault.pause();
        _fund(bob, 1e6);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mintSet(id, 1e6);
        // exits keep working while paused
        vm.prank(alice);
        vault.redeemSet(id, 4e6);
        _settle(RCSS, D, 30);
        vm.prank(alice);
        assertEq(vault.redeem(id, 6e6, 6e6), 6e6);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        vault.unpause();
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_mintSetWithPermit() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, holder, 50e6, 0, deadline);

        address relayer = makeAddr("relayer");
        // relayer cannot change the amount the holder signed for
        vm.prank(relayer);
        vm.expectRevert();
        vault.mintSetWithPermit(id, 40e6, holder, deadline, v, r, s);

        vm.prank(relayer);
        vault.mintSetWithPermit(id, 50e6, holder, deadline, v, r, s);
        assertEq(yes.balanceOf(holder), 50e6);
        assertEq(no.balanceOf(holder), 50e6);
        assertEq(yes.balanceOf(relayer), 0);
        assertEq(ausd.balanceOf(holder), 0);
        assertEq(ausd.nonces(holder), 1);

        // replay fails
        vm.prank(relayer);
        vm.expectRevert();
        vault.mintSetWithPermit(id, 50e6, holder, deadline, v, r, s);
    }

    function test_mintSetWithPermitExpiredOrFrontRun() public {
        bytes32 id = _create(RCSS, D, 30);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, holder, 50e6, 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert();
        vault.mintSetWithPermit(id, 50e6, holder, deadline, v, r, s);
        vm.warp(deadline);

        // a front-runner submitting the permit directly makes the relay revert (no silent fallback to allowance)
        ausd.permit(holder, address(vault), 50e6, deadline, v, r, s);
        vm.expectRevert();
        vault.mintSetWithPermit(id, 50e6, holder, deadline, v, r, s);
        // ...and nobody but the holder can spend that standing allowance
        vm.prank(bob);
        vm.expectRevert();
        vault.mintSet(id, 50e6);
    }

    // --- exits -------------------------------------------------------------------------------------

    function test_redeemSetBeforeAndAfterResolution() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        vault.redeemSet(id, 30e6);
        assertEq(ausd.balanceOf(alice), 30e6);
        assertEq(yes.balanceOf(alice), 70e6);
        assertEq(vault.getSeries(id).collateral, 70e6);

        _settle(RCSS, D, 35);
        vm.prank(alice);
        vault.redeemSet(id, 70e6);
        assertEq(ausd.balanceOf(alice), 100e6);
        assertEq(yes.totalSupply() + no.totalSupply(), 0);
        assertEq(ausd.balanceOf(address(vault)), 0);
    }

    function test_redeemSetNeedsBothLegs() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes,) = _tokens(id);
        _mint(alice, id, 10e6);
        vm.prank(alice);
        yes.transfer(bob, 5e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 5e6, 6e6));
        vault.redeemSet(id, 6e6);
        vm.prank(alice);
        vm.expectRevert(CollateralVault.ZeroAmount.selector);
        vault.redeemSet(id, 0);
    }

    function test_redeemRequiresResolution() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 10e6);
        vm.warp(RCSS_DAY_END + 23 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotResolved.selector, id));
        vault.redeem(id, 10e6, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotResolved.selector, id));
        vault.payoutHalves(id);
    }

    function test_yesWinsAtStrike() public {
        // Tmax == strike counts as ">=": YES wins
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        vm.prank(alice);
        no.transfer(bob, 100e6); // alice: 100 YES, bob: 100 NO
        _settle(RCSS, D, 30);
        (uint256 y, uint256 n) = vault.payoutHalves(id);
        assertEq(y, 2);
        assertEq(n, 0);
        vm.expectEmit(address(vault));
        emit Redeemed(id, alice, 100e6, 0, 100e6);
        vm.prank(alice);
        assertEq(vault.redeem(id, 100e6, 0), 100e6);
        vm.prank(bob);
        assertEq(vault.redeem(id, 0, 100e6), 0); // losers can burn for 0
        assertEq(ausd.balanceOf(alice), 100e6);
        assertEq(ausd.balanceOf(bob), 0);
        assertEq(yes.totalSupply() + no.totalSupply(), 0);
        assertEq(vault.getSeries(id).collateral, 0);
    }

    function test_noWinsBelowStrike() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        _settle(RCSS, D, 29);
        assertEq(vault.previewRedeem(id, 100e6, 100e6), 100e6);
        assertEq(vault.previewRedeem(id, 100e6, 0), 0);
        vm.prank(alice);
        assertEq(vault.redeem(id, 0, 100e6), 100e6);
    }

    function test_voidPaysHalf() public {
        bytes32 id = _create(RCSS, D, 30);
        (, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 101);
        vm.prank(alice);
        no.transfer(bob, 101);
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 0, true, keccak256("disagree")));
        (uint256 y, uint256 n) = vault.payoutHalves(id);
        assertEq(y, 1);
        assertEq(n, 1);
        vm.prank(alice);
        assertEq(vault.redeem(id, 101, 0), 50); // rounds down, dust stays in the vault
        vm.prank(bob);
        assertEq(vault.redeem(id, 0, 101), 50);
        assertEq(vault.getSeries(id).collateral, 1);
    }

    function test_voidFullSetRedeemsExactly() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 101);
        vm.warp(RCSS_DAY_END + 48 hours);
        resolver.voidIfStale(RCSS, D);
        vm.prank(alice);
        assertEq(vault.redeem(id, 101, 101), 101); // a full set always pays exactly 1 per set
    }

    function test_noDoubleRedeem() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 10e6);
        _settle(RCSS, D, 33);
        vm.startPrank(alice);
        vault.redeem(id, 10e6, 0);
        (OutcomeToken yes,) = _tokens(id);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 10e6));
        vault.redeem(id, 10e6, 0);
        vm.expectRevert(CollateralVault.ZeroAmount.selector);
        vault.redeem(id, 0, 0);
        vm.stopPrank();
        assertEq(yes.totalSupply(), 0);
        assertEq(ausd.balanceOf(alice), 10e6);
    }

    function test_oneReportSettlesWholeLadder() public {
        int16[] memory ks = new int16[](6);
        for (uint256 i; i < 6; ++i) {
            ks[i] = int16(int256(27 + i)); // 27..32
        }
        vm.prank(operator);
        bytes32[] memory ids = vault.createLadder(RCSS, D, ks, uint64(RCSS_DAY_END - 1 hours));
        for (uint256 i; i < 6; ++i) {
            _mint(alice, ids[i], 10e6);
        }
        _settle(RCSS, D, 30); // single CRE report
        for (uint256 i; i < 6; ++i) {
            (uint256 y,) = vault.payoutHalves(ids[i]);
            assertEq(y, ks[i] <= 30 ? 2 : 0);
            vm.prank(alice);
            assertEq(vault.redeem(ids[i], 10e6, 0), ks[i] <= 30 ? 10e6 : 0);
        }
        assertEq(ausd.balanceOf(alice), 40e6); // strikes 27,28,29,30 won
    }

    function test_seriesCollateralIsolated() public {
        bytes32 a = _create(RCSS, D, 30);
        bytes32 b = _create(RJTT, D, 25);
        _mint(alice, a, 10e6);
        _mint(bob, b, 1e6);
        _settle(RJTT, D, 25);
        vm.prank(bob);
        vault.redeem(b, 1e6, 1e6);
        assertEq(vault.getSeries(a).collateral, 10e6);
        assertEq(vault.getSeries(b).collateral, 0);
        assertEq(ausd.balanceOf(address(vault)), 10e6);
    }

    function test_settlementOfOtherLadderDoesNotLeak() public {
        bytes32 a = _create(RCSS, D, 30);
        _create(RJTT, D, 30);
        _mint(alice, a, 1e6);
        _settle(RJTT, D, 31); // Tokyo settled, Taipei not
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotResolved.selector, a));
        vault.redeem(a, 1e6, 0);
    }

    // --- due-ladder view (what the CRE workflow polls) --------------------------------------------

    function test_duePendingLadders() public {
        _create(RCSS, D, 30);
        _create(RJTT, D, 25);
        _create(RJTT, 20261008, 25);
        assertEq(vault.duePendingLadders(0, 10).length, 0);
        vm.warp(RJTT_DAY_END);
        StrikeFactory.LadderRef[] memory due = vault.duePendingLadders(0, 10);
        assertEq(due.length, 1);
        assertEq(due[0].station, RJTT);
        vm.warp(RCSS_DAY_END);
        assertEq(vault.duePendingLadders(0, 10).length, 2);
        assertEq(vault.duePendingLadders(1, 1).length, 1); // pagination
        assertEq(vault.duePendingLadders(5, 10).length, 0);
        _settle(RCSS, D, 30);
        due = vault.duePendingLadders(0, type(uint256).max);
        assertEq(due.length, 1);
        assertEq(due[0].station, RJTT);
        assertEq(due[0].date, D);
    }

    function test_guardianAdmin() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setGuardian(alice);
        vm.prank(owner);
        vault.setGuardian(alice);
        vm.prank(alice);
        vault.pause();
        assertTrue(vault.paused());
    }

    // --- challenge window: redemption opens at finalAt --------------------------------------------

    function test_redeemWaitsForChallengeWindow() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 10e6);
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 31, false, keccak256("s")));
        uint64 finalAt = uint64(RCSS_DAY_END + CHALLENGE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotFinal.selector, id, finalAt));
        vault.redeem(id, 10e6, 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotFinal.selector, id, finalAt));
        vault.payoutHalves(id);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotFinal.selector, id, finalAt));
        vault.previewRedeem(id, 1, 1);
        // a complete set can always exit at par, even inside the window
        vm.prank(alice);
        vault.redeemSet(id, 1e6);
        vm.warp(finalAt);
        vm.prank(alice);
        assertEq(vault.redeem(id, 9e6, 9e6), 9e6);
    }

    function test_challengedResultPaysHalf() public {
        bytes32 id = _create(RCSS, D, 30);
        (, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 100e6);
        vm.prank(alice);
        no.transfer(bob, 100e6);
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 35, false, keccak256("s"))); // a wrong (or compromised) report says YES wins
        vm.prank(guardian);
        resolver.challenge(RCSS, D, keccak256("bad report"));
        (uint256 y, uint256 n) = vault.payoutHalves(id); // final at once
        assertEq(y, 1);
        assertEq(n, 1);
        vm.prank(alice);
        assertEq(vault.redeem(id, 100e6, 0), 50e6);
        vm.prank(bob);
        assertEq(vault.redeem(id, 0, 100e6), 50e6);
    }

    // --- EIP-3009 gasless mint (series-bound) ------------------------------------------------------

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function _authSig(uint256 pk, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 sh =
            keccak256(abi.encode(RECEIVE_TYPEHASH, vm.addr(pk), address(vault), value, validAfter, validBefore, nonce));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), sh)));
    }

    function test_mintSetWithAuthorization() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        bytes32 salt = keccak256("salt-1");
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = vault.mintAuthorizationNonce(id, 50e6, salt);
        assertEq(nonce, keccak256(abi.encode(id, uint256(50e6), salt)));
        (uint8 v, bytes32 r, bytes32 s) = _authSig(pk, 50e6, 0, vb, nonce);

        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, vb, salt, v, r, s);
        assertEq(yes.balanceOf(holder), 50e6);
        assertEq(no.balanceOf(holder), 50e6);
        assertEq(yes.balanceOf(relayer), 0);
        assertEq(ausd.balanceOf(holder), 0);
        assertEq(vault.getSeries(id).collateral, 50e6);
        assertTrue(ausd.authorizationState(holder, nonce));
        assertEq(ausd.allowance(holder, address(vault)), 0, "no allowance involved");

        ausd.mint(holder, 50e6);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, vb, salt, v, r, s); // replay
    }

    /// The fix for the permit front-run: the series and amount are bound into the 3009 nonce, recomputed by the vault.
    function test_mintSetWithAuthorizationCannotBeRedirected() public {
        bytes32 wanted = _create(RCSS, D, 30);
        bytes32 other = _create(RCSS, D, 25);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        bytes32 salt = keccak256("salt-2");
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _authSig(pk, 50e6, 0, vb, vault.mintAuthorizationNonce(wanted, 50e6, salt));

        vm.startPrank(makeAddr("frontRunner"));
        vm.expectRevert("FiatTokenV2: invalid signature");
        vault.mintSetWithAuthorization(other, 50e6, holder, 0, vb, salt, v, r, s); // another series
        vm.expectRevert("FiatTokenV2: invalid signature");
        vault.mintSetWithAuthorization(wanted, 40e6, holder, 0, vb, salt, v, r, s); // another amount
        vm.expectRevert("FiatTokenV2: invalid signature");
        vault.mintSetWithAuthorization(wanted, 50e6, holder, 0, vb, keccak256("x"), v, r, s); // another salt
        vm.stopPrank();
        // nobody but the vault can consume it directly (payee must be the caller)
        _thiefTriesDirect(holder, vb, vault.mintAuthorizationNonce(wanted, 50e6, salt), v, r, s);
        vm.prank(makeAddr("relayer"));
        vault.mintSetWithAuthorization(wanted, 50e6, holder, 0, vb, salt, v, r, s);
        (OutcomeToken yes,) = _tokens(wanted);
        assertEq(yes.balanceOf(holder), 50e6);
    }

    function _thiefTriesDirect(address holder, uint256 vb, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) internal {
        vm.prank(makeAddr("thief"));
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        ausd.receiveWithAuthorization(holder, address(vault), 50e6, 0, vb, nonce, v, r, s);
    }

    function test_mintSetWithAuthorizationChecks() public {
        bytes32 id = _create(RCSS, D, 30);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        bytes32 salt = keccak256("salt-3");
        uint256 vb = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _authSig(pk, 50e6, 0, vb, vault.mintAuthorizationNonce(id, 50e6, salt));
        vm.warp(vb);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, vb, salt, v, r, s);
        vm.warp(vb - 1);
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, vb, salt, v, r, s);
        vm.prank(owner);
        vault.unpause();
        uint64 close = vault.getSeries(id).closeTime;
        vm.warp(close);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.MintClosed.selector, id, close));
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, type(uint256).max, salt, v, r, s);
    }

    // --- collateral balance-delta check ------------------------------------------------------------

    function test_feeOnTransferCollateralRejected() public {
        FeeToken fee = new FeeToken();
        CollateralVault fv = new CollateralVault(owner, resolver, fee, guardian);
        vm.prank(owner);
        bytes32 id = fv.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END - 1 hours));
        fee.mint(alice, 100e6);
        vm.startPrank(alice);
        fee.approve(address(fv), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.CollateralTransferMismatch.selector, 100e6, 99e6));
        fv.mintSet(id, 100e6);
        vm.stopPrank();
    }

    // --- compliance: gated series ------------------------------------------------------------------

    function test_gatedSeriesMintsOnlyToAllowlisted() public {
        bytes32 id = _create(RCSS, D, 30);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setSeriesGated(id, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrikeFactory.UnknownSeries.selector, bytes32(uint256(1))));
        vault.setSeriesGated(bytes32(uint256(1)), true);
        vm.prank(owner);
        vault.setSeriesGated(id, true);
        assertTrue(vault.getSeries(id).gated);

        _fund(alice, 20e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotAllowlisted.selector, id, alice));
        vault.mintSet(id, 1e6);
        vm.prank(owner);
        vault.setAllowlisted(alice, true);
        vm.prank(alice);
        vault.mintSet(id, 1e6);
        vm.prank(alice); // the recipient is what is gated
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotAllowlisted.selector, id, bob));
        vault.mintSetTo(id, 1e6, bob);
        // secondary transfers and exits are not gated
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        vm.startPrank(alice);
        yes.transfer(bob, 1e6);
        no.transfer(bob, 1e6);
        vm.stopPrank();
        vm.prank(bob);
        vault.redeemSet(id, 1e6);
        // ungating opens it to everyone
        vm.prank(owner);
        vault.setSeriesGated(id, false);
        _mint(bob, id, 1e6);
    }

    // --- helpers -----------------------------------------------------------------------------------

    function _permitSig(uint256 pk, address holder, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, holder, address(vault), value, nonce, deadline));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash)));
    }
}
