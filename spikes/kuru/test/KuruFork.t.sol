// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IKuruRouter, IKuruOrderBook, IKuruMarginAccount} from "../src/interfaces/IKuru.sol";
import {SpikeToken, SpikeCompleteSet} from "../src/SpikeToken.sol";
import {KuruZap} from "../src/KuruZap.sol";
import {LiveProbe} from "../src/LiveProbe.sol";

interface IFaucet {
    function requestFunds(address) external;
}

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// Run against an anvil fork of Monad testnet (or the live RPC):
///   forge test --fork-url http://127.0.0.1:8546 -vv
contract KuruForkTest is Test {
    address constant ROUTER = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
    address constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address constant FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    // Isotherm YES/AUSD params
    uint96 constant SIZE_PRECISION = 1e6;
    uint32 constant PRICE_PRECISION = 1e4;
    uint32 constant TICK = 10;
    uint96 constant MIN_SIZE = 1e6;
    uint96 constant MAX_SIZE = 1e12;

    address maker = 0xd572638F07829D1c3636400FB73CF34Ca6c7448a;
    address taker1 = 0x636D0598E416e5f66acD0F6Ac2Ae96306529b4d5;
    address taker2 = 0x029049a9dA77231dd86A90E52Fd6Db542424e727;
    address nobody = address(0xBEEF);

    IKuruMarginAccount MA;

    function setUp() public {
        require(block.chainid == 10143, "run with --fork-url <monad testnet or anvil fork>");
        MA = IKuruMarginAccount(IKuruRouter(ROUTER).marginAccountAddress());
    }

    function _fundAusd(address to, uint256 amt) internal {
        // the faucet drips 10,000 AUSD per call and is rate limited (60 s); warp between drips
        uint256 have;
        while (have < amt) {
            vm.warp(vm.getBlockTimestamp() + 61);
            IFaucet(FAUCET).requestFunds(address(this));
            have += 10_000e6;
        }
        IERC20T(AUSD).transfer(to, amt);
    }

    function _deploy(address base, uint256 takerBps) internal returns (address m) {
        m = IKuruRouter(ROUTER).deployProxy(
            0, base, AUSD, SIZE_PRECISION, PRICE_PRECISION, TICK, MIN_SIZE, MAX_SIZE, takerBps, 0, 100
        );
    }

    function _quote(address m) internal {
        vm.startPrank(maker);
        uint32[] memory bp = new uint32[](3);
        uint96[] memory bs = new uint96[](3);
        uint32[] memory ap = new uint32[](3);
        uint96[] memory as_ = new uint96[](3);
        (bp[0], bp[1], bp[2]) = (4000, 3950, 3900);
        (ap[0], ap[1], ap[2]) = (4100, 4150, 4200);
        for (uint256 i; i < 3; i++) {
            bs[i] = 200e6;
            as_[i] = 200e6;
        }
        IKuruOrderBook(m).batchUpdate(bp, bs, ap, as_, new uint40[](0), true);
        vm.stopPrank();
    }

    function test_nonOwnerCanCreateMarket() public {
        SpikeToken yes = new SpikeToken("YES", "YES", address(this));
        vm.prank(nobody);
        address m = _deploy(address(yes), 10);
        (uint32 pp, uint96 sp, address b,, address q,, uint32 tick, uint96 mn, uint96 mx, uint256 tf, uint256 mf) =
            IKuruOrderBook(m).getMarketParams();
        assertEq(pp, PRICE_PRECISION);
        assertEq(sp, SIZE_PRECISION);
        assertEq(b, address(yes));
        assertEq(q, AUSD);
        assertEq(tick, TICK);
        assertEq(mn, MIN_SIZE);
        assertEq(mx, MAX_SIZE);
        assertEq(tf, 10);
        assertEq(mf, 0);
        (uint32 rpp,,,,,,,,,,) = IKuruRouter(ROUTER).verifiedMarket(m);
        assertEq(rpp, PRICE_PRECISION, "router registered the market");
        console2.log("market created by non-owner:", m);
    }

    function test_liveProbeOnFork() public {
        vm.warp(vm.getBlockTimestamp() + 61); // faucet global 60 s cooldown
        LiveProbe probe = new LiveProbe();
        LiveProbe.Report memory r = probe.run(ROUTER, AUSD, FAUCET);
        console2.log("market", r.market);
        console2.log("gas create/deposit/bid/ask", r.gasCreateMarket, r.gasMakerDeposit, r.gasPlaceBid);
        console2.log("gas ask/batch6/buy", r.gasPlaceAsk, r.gasBatchUpdate6, r.gasTakerMarketBuy);
        console2.log("gas sell/cancel6", r.gasTakerMarketSell, r.gasCancelAll);
        console2.log("taker YES received for 100 AUSD", r.takerYesReceived);
        console2.log("taker AUSD received for 20 YES", r.takerAusdReceived);
        assertGt(r.takerYesReceived, 0);
        assertGt(r.takerAusdReceived, 0);
        assertEq(r.orderIdCounter, 8);
    }

    /// Zap = a contract taking liquidity on behalf of users: buy YES, sell YES, buy NO (mint set + sell YES),
    /// plus Kuru's own Router.anyToAnySwap as the zero-deploy alternative for "buy YES".
    function test_zapPaths() public {
        SpikeCompleteSet set = new SpikeCompleteSet(AUSD, "RCSS Tmax>=30C 2026-10-08");
        address yes = address(set.yes());
        address no = address(set.no());
        address m = _deploy(yes, 10);
        KuruZap zap = new KuruZap();

        // maker mints 1,000 complete sets, deposits YES + AUSD to the margin account, quotes 3x3
        _fundAusd(maker, 3_000e6);
        vm.startPrank(maker);
        IERC20T(AUSD).approve(address(set), type(uint256).max);
        set.mint(maker, 1_000e6);
        IERC20T(AUSD).approve(address(MA), type(uint256).max);
        IERC20T(yes).approve(address(MA), type(uint256).max);
        MA.deposit(maker, AUSD, 1_000e6);
        MA.deposit(maker, yes, 1_000e6);
        vm.stopPrank();
        _quote(m);

        // --- user 1: buy YES with 50 AUSD through the zap
        _fundAusd(taker1, 200e6);
        vm.startPrank(taker1);
        IERC20T(AUSD).approve(address(zap), type(uint256).max);
        (uint256 yesOut, uint256 refund) = zap.buyYes(m, 50e6, 1, taker1);
        console2.log("zap.buyYes: 50 AUSD ->", yesOut, "YES(6dp); refund", refund);
        assertEq(IERC20T(yes).balanceOf(taker1), yesOut);
        assertEq(IERC20T(yes).balanceOf(address(zap)), 0, "zap holds nothing");
        assertEq(IERC20T(AUSD).balanceOf(address(zap)), 0, "zap holds nothing");

        // --- user 1: sell half the YES back through the zap
        IERC20T(yes).approve(address(zap), type(uint256).max);
        (uint256 ausdOut,) = zap.sellYes(m, yesOut / 2, 1, taker1);
        console2.log("zap.sellYes:", yesOut / 2, "YES -> AUSD", ausdOut);
        assertGt(ausdOut, 0);

        // --- user 1: buy NO exposure with 40 AUSD (mint set, sell YES leg at the bid)
        (uint256 noOut, uint256 ausdBack) = zap.buyNo(address(set), m, 40e6, 1, taker1);
        console2.log("zap.buyNo: 40 AUSD -> NO", noOut);
        console2.log("           AUSD back", ausdBack);
        assertEq(IERC20T(no).balanceOf(taker1), noOut);
        assertEq(IERC20T(AUSD).balanceOf(address(zap)), 0);
        assertEq(IERC20T(yes).balanceOf(address(zap)), 0);
        vm.stopPrank();

        // --- user 2: buy YES with Kuru's Router (approve ROUTER, fill-or-kill)
        _fundAusd(taker2, 100e6);
        vm.startPrank(taker2);
        IERC20T(AUSD).approve(ROUTER, 30e6);
        address[] memory mk = new address[](1);
        mk[0] = m;
        bool[] memory isBuy = new bool[](1);
        isBuy[0] = true;
        bool[] memory nat = new bool[](1);
        uint256 out = IKuruRouter(ROUTER).anyToAnySwap(mk, isBuy, nat, AUSD, yes, 30e6, 1);
        console2.log("router.anyToAnySwap: 30 AUSD -> YES", out);
        assertEq(IERC20T(yes).balanceOf(taker2), out);
        vm.stopPrank();

        // maker's fills accrued in the margin account
        console2.log("maker margin AUSD", MA.getBalance(maker, AUSD));
        console2.log("maker margin YES ", MA.getBalance(maker, yes));
    }

    /// The maker must hold BOTH legs in the margin account: bids lock AUSD, asks lock YES.
    function test_postOnlyAndInsufficientMargin() public {
        address mk = makeAddr("freshMaker"); // fresh address: no margin balance yet
        SpikeToken yes = new SpikeToken("YES", "YES", address(this));
        address m = _deploy(address(yes), 0);
        vm.prank(mk);
        vm.expectRevert(); // InsufficientBalance in MarginAccount
        IKuruOrderBook(m).addBuyOrder(5000, 10e6, true);

        yes.mint(mk, 100e6);
        _fundAusd(mk, 100e6);
        vm.startPrank(mk);
        IERC20T(AUSD).approve(address(MA), type(uint256).max);
        yes.approve(address(MA), type(uint256).max);
        MA.deposit(mk, AUSD, 100e6);
        MA.deposit(mk, address(yes), 100e6);
        IKuruOrderBook(m).addSellOrder(5000, 10e6, true);
        vm.expectRevert(); // post-only bid that would cross the 0.50 ask
        IKuruOrderBook(m).addBuyOrder(5000, 10e6, true);
        vm.expectRevert(); // off-tick price (0.4995 is not a multiple of the 0.001 tick)
        IKuruOrderBook(m).addBuyOrder(4995, 10e6, true);
        vm.stopPrank();
    }
}
