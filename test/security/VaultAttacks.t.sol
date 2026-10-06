// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IsoTest} from "../utils/IsoTest.sol";
import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {HookToken, FeeToken, ITokenHook} from "./SecUtils.sol";

/// @dev Attacker that tries to re-enter every vault entry point from inside a collateral transfer callback.
contract ReentrantAttacker is ITokenHook {
    CollateralVault public immutable vault;
    bytes32 public id;
    uint256 public attempts;
    uint256 public blockedByGuard;
    uint256 public succeeded;

    constructor(CollateralVault v) {
        vault = v;
    }

    function setId(bytes32 id_) external {
        id = id_;
    }

    function approve(IERC20 t) external {
        t.approve(address(vault), type(uint256).max);
    }

    function mint(uint256 a) external {
        vault.mintSet(id, a);
    }

    function redeem(uint256 y, uint256 n) external returns (uint256) {
        return vault.redeem(id, y, n);
    }

    function redeemSet(uint256 a) external {
        vault.redeemSet(id, a);
    }

    function onTokenReceived(address, uint256) external {
        bytes[3] memory calls = [
            abi.encodeCall(CollateralVault.redeem, (id, 1, 0)),
            abi.encodeCall(CollateralVault.redeemSet, (id, 1)),
            abi.encodeCall(CollateralVault.mintSet, (id, 1))
        ];
        for (uint256 i; i < 3; ++i) {
            attempts++;
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            if (ok) succeeded++;
            else if (bytes4(ret) == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector) blockedByGuard++;
        }
    }
}

contract VaultAttacksTest is IsoTest {
    bytes32 internal constant SRC = keccak256("sources");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _permitSig(uint256 pk, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 sh = keccak256(abi.encode(PERMIT_TYPEHASH, vm.addr(pk), address(vault), value, nonce, deadline));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), sh)));
    }

    // ------------------------------------------------------------------------------------------------
    // Gasless mint (permit) front-running
    // ------------------------------------------------------------------------------------------------

    /// FINDING (Low): the AUSD permit signs (holder, vault, amount, nonce, deadline) but NOT the seriesId, so anyone
    /// who sees the relayer's pending calldata can submit it first with a different open seriesId. No funds are lost
    /// (tokens still go to the holder and a complete set redeems at par any time) but the relayed flow fails and the
    /// holder pays gas to unwind. Fix: bind the intent - e.g. mintSetWithAuthorization over EIP-3009
    /// receiveWithAuthorization with nonce = keccak256(abi.encode(seriesId, amount, salt)) recomputed by the vault.
    function test_permitDoesNotBindSeries_frontRunnerChoosesTheSeries() public {
        bytes32 wanted = _create(RCSS, D, 30);
        bytes32 other = _create(RCSS, D, 25);
        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        uint256 deadline = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, 50e6, 0, deadline);

        vm.prank(makeAddr("frontRunner"));
        vault.mintSetWithPermit(other, 50e6, holder, deadline, v, r, s);
        vm.prank(makeAddr("relayer"));
        vm.expectRevert();
        vault.mintSetWithPermit(wanted, 50e6, holder, deadline, v, r, s);

        (OutcomeToken yes, OutcomeToken no) = _tokens(other);
        assertEq(yes.balanceOf(holder), 50e6, "holder got a series it never chose");
        assertEq(no.balanceOf(holder), 50e6);
        vm.prank(holder);
        vault.redeemSet(other, 50e6);
        assertEq(ausd.balanceOf(holder), 50e6, "recoverable at par (gas only)");
    }

    /// INFO: a permit sets allowance := amount, so a holder's standing max approval to the vault is wiped.
    function test_permitOverwritesStandingAllowance() public {
        bytes32 id = _create(RCSS, D, 30);
        uint256 pk = 0xD1B;
        address holder = vm.addr(pk);
        ausd.mint(holder, 100e6);
        vm.prank(holder);
        ausd.approve(address(vault), type(uint256).max);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, 10e6, 0, block.timestamp + 60);
        vault.mintSetWithPermit(id, 10e6, holder, block.timestamp + 60, v, r, s);
        assertEq(ausd.allowance(holder, address(vault)), 0, "max approval replaced by 10 then consumed");
    }

    // ------------------------------------------------------------------------------------------------
    // Reentrancy through a hooked collateral
    // ------------------------------------------------------------------------------------------------

    function test_reentrancyFromCollateralCallbackBlockedOnEveryEntryPoint() public {
        HookToken hook = new HookToken();
        CollateralVault hv = new CollateralVault(owner, resolver, hook, guardian);
        uint64 close = uint64(RCSS_DAY_END - 1 hours);
        vm.prank(owner);
        bytes32 id = hv.createSeries(RCSS, D, 30, close);
        ReentrantAttacker atk = new ReentrantAttacker(hv);
        atk.setId(id);
        atk.approve(hook);
        hook.mint(address(atk), 200e6);
        atk.mint(200e6);
        hook.setHookTarget(address(atk));

        atk.redeemSet(50e6); // payout transfer -> callback -> 3 re-entry attempts
        _settle(RCSS, D, 31); // YES wins
        assertEq(atk.redeem(150e6, 150e6), 150e6);
        assertEq(atk.attempts(), 6);
        assertEq(atk.blockedByGuard(), 6, "every re-entry hit ReentrancyGuardReentrantCall");
        assertEq(atk.succeeded(), 0);
        assertEq(hook.balanceOf(address(hv)), 0);
        assertEq(hook.balanceOf(address(atk)), 200e6, "got back exactly what was deposited");
    }

    // ------------------------------------------------------------------------------------------------
    // Collateral assumptions
    // ------------------------------------------------------------------------------------------------

    /// FINDING (Low / assumption): the vault credits `amount`, not what it received. With a fee-on-transfer collateral
    /// (AUSD is an upgradeable proxy) the books overstate reserves; early exiters drain later ones. The constructor
    /// only checks decimals == 6, so this is a deploy-time trust assumption on the collateral.
    function test_feeOnTransferCollateralMakesLastRedeemerInsolvent() public {
        FeeToken fee = new FeeToken();
        CollateralVault fv = new CollateralVault(owner, resolver, fee, guardian);
        vm.prank(owner);
        bytes32 id = fv.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END - 1 hours));
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            fee.mint(users[i], 100e6);
            vm.startPrank(users[i]);
            fee.approve(address(fv), type(uint256).max);
            fv.mintSet(id, 100e6);
            vm.stopPrank();
        }
        assertEq(fv.getSeries(id).collateral, 200e6, "books say 200");
        assertEq(fee.balanceOf(address(fv)), 198e6, "vault holds 198");
        vm.prank(alice);
        fv.redeemSet(id, 100e6);
        vm.prank(bob);
        vm.expectRevert(); // ERC20InsufficientBalance: 98 left for a 100 claim
        fv.redeemSet(id, 100e6);
    }

    // ------------------------------------------------------------------------------------------------
    // Rounding (6 decimals, void pays 0.5)
    // ------------------------------------------------------------------------------------------------

    /// Splitting void redemptions into odd chunks can only lose the redeemer <= 0.5 base unit per call; the vault never
    /// pays more than was deposited and stays exactly solvent for the remaining supply.
    function testFuzz_voidRoundingNeverOverpays(uint256 minted, uint256[10] memory cuts) public {
        minted = bound(minted, 1, 1e12);
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, minted);
        vm.warp(RCSS_DAY_END + resolver.STALE_WINDOW());
        resolver.voidIfStale(RCSS, D);

        uint256 paid;
        uint256 calls;
        for (uint256 i; i < cuts.length + 1; ++i) {
            uint256 y =
                i < cuts.length ? bound(cuts[i] & type(uint128).max, 0, yes.balanceOf(alice)) : yes.balanceOf(alice);
            uint256 n = i < cuts.length ? bound(cuts[i] >> 128, 0, no.balanceOf(alice)) : no.balanceOf(alice);
            if (y + n == 0) continue;
            vm.prank(alice);
            paid += vault.redeem(id, y, n);
            calls++;
            uint256 claim = (yes.totalSupply() + no.totalSupply()) / 2;
            assertGe(vault.getSeries(id).collateral, claim, "solvent after every call");
        }
        assertLe(paid, minted, "never overpays");
        assertGe(2 * paid + calls, 2 * minted, "loses at most 0.5 unit per call");
        assertEq(ausd.balanceOf(address(vault)), minted - paid, "dust stays in the vault");
        assertEq(vault.getSeries(id).collateral, minted - paid);
    }

    /// 1-unit redemptions in a void: each call burns 1 token and pays 0. Self-inflicted only; nobody else's claim moves.
    function test_voidOneUnitRedemptionsPayZeroButCannotHurtOthers() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 10);
        _mint(bob, id, 10);
        vm.warp(RCSS_DAY_END + 24 hours);
        resolver.voidIfStale(RCSS, D);
        uint256 got;
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            got += vault.redeem(id, 1, 0);
        }
        assertEq(got, 0, "alice burned 10 YES for 0");
        vm.prank(alice);
        assertEq(vault.redeem(id, 0, 10), 5);
        vm.prank(bob);
        assertEq(vault.redeem(id, 10, 10), 10, "bob unaffected");
        assertEq(ausd.balanceOf(address(vault)), 5, "alice's rounding loss stays in the vault forever (no sweep)");
    }

    // ------------------------------------------------------------------------------------------------
    // Cross-series and double-redeem
    // ------------------------------------------------------------------------------------------------

    function testFuzz_cannotRedeemAnotherSeriesCollateral(uint256 amt, bool settleYes) public {
        amt = bound(amt, 1, 1e12);
        bytes32 a = _create(RCSS, D, 30);
        bytes32 b = _create(RCSS, D, 20);
        _mint(alice, a, amt);
        _mint(bob, b, amt);
        _settle(RCSS, D, settleYes ? int16(35) : int16(10));
        vm.startPrank(alice);
        vm.expectRevert();
        vault.redeem(b, amt, 0);
        vm.expectRevert();
        vault.redeem(b, 0, amt);
        vm.expectRevert();
        vault.redeemSet(b, 1);
        uint256 got = vault.redeem(a, amt, amt);
        vm.expectRevert();
        vault.redeem(a, amt, amt); // double redeem: tokens are burned
        vm.stopPrank();
        assertEq(got, amt);
        assertEq(vault.getSeries(b).collateral, amt, "series b untouched");
    }

    // ------------------------------------------------------------------------------------------------
    // Monad: 1-second TIMESTAMP shared by ~3 blocks
    // ------------------------------------------------------------------------------------------------

    /// For every closeTime in (now, dayEnd] and every timestamp, minting and settling are never both possible in the
    /// same second (or the same block), whatever the block order inside that second.
    function testFuzz_monadNoSecondWhereMintAndSettleBothSucceed(
        uint256 closeSeed,
        uint256 tSeed,
        uint8 blocks,
        uint8 mode
    ) public {
        // half the runs close exactly at dayEnd; 2/3 of runs land on the close second or the one before it
        uint64 close = mode % 2 == 0 ? uint64(RCSS_DAY_END) : uint64(bound(closeSeed, T0 + 1, RCSS_DAY_END));
        vm.prank(operator);
        bytes32 id = vault.createSeries(RCSS, D, 30, close);
        uint256 t =
            (mode / 2) % 3 == 0 ? close : (mode / 2) % 3 == 1 ? close - 1 : bound(tSeed, T0, RCSS_DAY_END + 2 days);
        vm.warp(t);
        _fund(alice, 10e6);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        blocks = uint8(bound(blocks, 1, 4));
        bool anyMint;
        bool anySettle;
        for (uint256 i; i < blocks; ++i) {
            vm.roll(block.number + 1); // same second
            vm.prank(alice);
            (bool m,) = address(vault).call(abi.encodeCall(CollateralVault.mintSet, (id, 1e6)));
            vm.prank(forwarder);
            (bool s,) = address(resolver).call(abi.encodeCall(Resolver.onReport, (new bytes(64), rep)));
            anyMint = anyMint || m;
            anySettle = anySettle || s;
            assertEq(m, t < close, "mint open iff t < closeTime");
        }
        assertFalse(anyMint && anySettle, "mint and settle in the same second");
        assertEq(anySettle, t >= RCSS_DAY_END, "settle iff t >= dayEnd");
    }

    /// closeTime == dayEnd is allowed. In the dayEnd second (3 Monad blocks) mint must already be closed while the
    /// report is accepted; in the second before, mint is open and the report is refused.
    function test_monadCloseAtDayEndSameSecondBoundary() public {
        vm.prank(operator);
        bytes32 id = vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END));
        _fund(alice, 10e6);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.warp(RCSS_DAY_END - 1);
        vm.prank(alice);
        vault.mintSet(id, 1e6);
        vm.expectRevert(abi.encodeWithSelector(Resolver.DayNotOver.selector, RCSS, D, RCSS_DAY_END));
        _deliver(rep);
        vm.warp(RCSS_DAY_END);
        for (uint256 i; i < 3; ++i) {
            vm.roll(block.number + 1);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(CollateralVault.MintClosed.selector, id, uint64(RCSS_DAY_END)));
            vault.mintSet(id, 1e6);
        }
        _deliver(rep);
    }

    // ------------------------------------------------------------------------------------------------
    // Admin powers
    // ------------------------------------------------------------------------------------------------

    /// Owner / guardian / operator have no direct path to collateral; exits keep working with BOTH vault and resolver
    /// paused (redeemSet before resolution, redeem after a stale void). The owner's real power is over the oracle
    /// (setAttester / setForwarder), see ResolverAttacks.
    function test_adminPowersCannotMoveOrFreezeCollateral() public {
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, 100e6);
        _mint(bob, id, 50e6);
        uint256 bal = ausd.balanceOf(address(vault));
        vm.startPrank(owner);
        vault.pause();
        vault.setGuardian(owner);
        vault.setOperator(owner, true);
        vault.createSeries(RCSS, D, 31, uint64(RCSS_DAY_END - 1 hours));
        resolver.pause();
        resolver.setGuardian(owner);
        vm.stopPrank();
        assertEq(ausd.balanceOf(address(vault)), bal);

        vm.prank(alice);
        vault.redeemSet(id, 100e6);
        assertEq(ausd.balanceOf(alice), 100e6);
        vm.warp(RCSS_DAY_END + 24 hours);
        resolver.voidIfStale(RCSS, D);
        vm.prank(bob);
        assertEq(vault.redeem(id, 50e6, 50e6), 50e6);
        assertEq(ausd.balanceOf(address(vault)), 0);
    }

    /// INFO (market design): an operator may list a new strike, and minting may stay open, until the last second of
    /// the local day, when the day's max is effectively already observed (METAR every 30 min). Nothing in the contract
    /// stops quoting/minting on a decided strike; the maker bot must not quote it.
    function test_operatorCanListAndMintInTheLastSecondsOfTheDay() public {
        vm.warp(RCSS_DAY_END - 2);
        vm.prank(operator);
        bytes32 id = vault.createSeries(RCSS, D, 30, uint64(RCSS_DAY_END));
        _mint(alice, id, 1e6);
        vm.warp(RCSS_DAY_END - 1);
        _mint(bob, id, 1e6);
        assertEq(vault.getSeries(id).collateral, 2e6);
    }
}
