// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {IsothermZap} from "../../src/IsothermZap.sol";
import {IKuruRouterView} from "../../src/interfaces/IKuru.sol";

interface IFaucet {
    function requestFunds(address to) external;
}

interface IMockForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata ctx, bytes[] calldata sigs) external;
}

interface IKuruRouter {
    function deployProxy(
        uint8 t,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 ammSpread
    ) external returns (address);
}

interface IKuruBook {
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancel,
        bool postOnly
    ) external;
    function batchCancelOrdersNoRevert(uint40[] calldata ids) external;
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minOut, bool isMargin, bool fok)
        external
        payable
        returns (uint256);
    function s_orderIdCounter() external view returns (uint40);
    function bestBidAsk() external view returns (uint256, uint256);
}

interface IMargin {
    function deposit(address user, address token, uint256 amount) external payable;
    function batchWithdrawMaxTokens(address[] calldata tokens) external;
}

/// @notice The whole Isotherm product loop, in-process, against LIVE Monad testnet state (10143) on a fork:
///         real testnet AUSD + faucet, real Kuru v1 Router/MarginAccount/OrderBooks, real CRE MockKeystoneForwarder.
///   deploy -> Taipei ladder (28/29/30) -> maker mints + quotes two-sided on 3 new Kuru books
///   -> taker1 buys YES>=29 on the book -> taker2 zaps buyNo(>=30) and buyYes(>=28)
///   -> maker re-quotes, pulls quotes at close -> day ends -> CRE report (tmax 29) via the mock forwarder
///   -> redeem (winners paid 1, losers 0) -> void ladder pays 0.5/0.5 -> stale ladder voided by anyone.
/// Run: MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=<n> forge test --match-path test/integration/* -vv
contract IsothermE2EForkTest is Test {
    IERC20 constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IFaucet constant FAUCET = IFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    IMockForwarder constant MOCK_FWD = IMockForwarder(0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    IKuruRouter constant ROUTER = IKuruRouter(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IMargin constant MARGIN = IMargin(0xd029C2D98ff85D8F64799017fE00a59B1159CE02);
    bytes32 constant REPORT_PROCESSED = keccak256("ReportProcessed(address,bytes32,bytes2,bool)");

    uint256 constant ATTESTER_PK = 0xA11CE; // test-only key; on the TS/live run the attester is the deployer
    address deployer;
    address maker = makeAddr("maker");
    address taker1 = makeAddr("taker1");
    address taker2 = makeAddr("taker2");
    address transmitter = makeAddr("creTransmitter");

    Resolver resolver;
    CollateralVault vault;
    IsothermZap zap;
    bool forked;

    uint32 date;
    bytes32[3] ids;
    address[3] markets;
    uint40[] makerOrders;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;

        deployer = vm.addr(ATTESTER_PK);
        vm.startPrank(deployer);
        resolver = new Resolver(deployer, address(MOCK_FWD), deployer, deployer, 15 minutes);
        vault = new CollateralVault(deployer, resolver, AUSD, deployer);
        resolver.registerStation("RCSS", 8 hours);
        resolver.registerStation("RJTT", 9 hours);
        resolver.registerStation("ZGSZ", 8 hours);
        vm.stopPrank();
        zap = new IsothermZap(IKuruRouterView(address(ROUTER)), vault);
    }

    // scenario state (kept in storage to stay clear of stack-too-deep)
    uint256 dayEnd;
    bytes32 voidId;
    bytes32 staleId;
    uint256 yes29;
    uint256 no30;
    uint256 back30;
    uint256 yes28;
    uint32[3] fv = [uint32(8000), 5500, 3000]; // maker fair values in 1e-4 AUSD (0.80 / 0.55 / 0.30)

    function test_e2e_fullLoop() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _createLadders(); //    2
        _makerInventoryAndQuotes(); // 3, 4
        _takers(); //           5
        _requoteAndClose(); //  6
        _settle(); //           7
        _redeemSettled(); //    8
        _voidAndStale(); //     9, 10
        _solvency(); //         11
    }

    function _createLadders() internal {
        date = _taipeiDate(block.timestamp);
        if (resolver.dayEnd("RCSS", date) - block.timestamp < 3 hours) date = _taipeiDate(block.timestamp + 1 days);
        dayEnd = resolver.dayEnd("RCSS", date);
        int16[] memory strikes = new int16[](3);
        (strikes[0], strikes[1], strikes[2]) = (int16(28), int16(29), int16(30));
        vm.startPrank(deployer);
        bytes32[] memory created = vault.createLadder("RCSS", date, strikes, uint64(dayEnd - 1 hours));
        voidId = vault.createSeries("RJTT", date, 25, uint64(resolver.dayEnd("RJTT", date) - 1 hours));
        staleId = vault.createSeries("ZGSZ", date, 30, uint64(resolver.dayEnd("ZGSZ", date) - 1 hours));
        vm.stopPrank();
        for (uint256 i; i < 3; ++i) ids[i] = created[i];
        console2.log("ladder RCSS date", date, "dayEnd", dayEnd);
    }

    function _makerInventoryAndQuotes() internal {
        _faucet(maker);
        vm.startPrank(maker);
        AUSD.approve(address(vault), type(uint256).max);
        for (uint256 i; i < 3; ++i) vault.mintSet(ids[i], 500e6);
        vault.mintSet(voidId, 100e6);
        vault.mintSet(staleId, 10e6);
        // one Kuru YES/AUSD book per strike (permissionless v1 testnet Router); maker quotes two-sided
        AUSD.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(maker, address(AUSD), 800e6);
        for (uint256 i; i < 3; ++i) {
            address yes = address(vault.getSeries(ids[i]).yes);
            markets[i] = ROUTER.deployProxy(0, yes, address(AUSD), 1e6, 1e4, 10, 1e6, 1e12, 10, 0, 100);
            IERC20(yes).approve(address(MARGIN), type(uint256).max);
            vm.stopPrank();
            vm.prank(deployer); // operator registers the canonical book (write-once)
            zap.setCanonicalMarket(ids[i], markets[i]);
            vm.startPrank(maker);
            MARGIN.deposit(maker, yes, 300e6);
            _quote(markets[i], fv[i] - 200, fv[i] + 200, new uint40[](0));
        }
        vm.stopPrank();
    }

    function _takers() internal {
        _faucet(taker1);
        vm.startPrank(taker1);
        AUSD.approve(markets[1], 50e6);
        yes29 = IKuruBook(markets[1]).placeAndExecuteMarketBuy(50e4, 0, false, true); // 50 AUSD, fill-or-kill
        assertEq(IERC20(address(vault.getSeries(ids[1]).yes)).balanceOf(taker1), yes29, "taker1 YES>=29 in wallet");
        // 50 / 0.57 = 87.719298 YES minus the 0.1% Kuru taker fee
        assertApproxEqAbs(yes29, 87_631_578, 2, "taker1 fill at the 0.57 ask");
        AUSD.transfer(taker2, 200e6);
        vm.stopPrank();

        vm.startPrank(taker2);
        AUSD.approve(address(zap), type(uint256).max); // once, for every strike and every day
        uint256 a0 = AUSD.balanceOf(taker2);
        (no30, back30) = zap.buyNo(ids[2], markets[2], 40e6, 10e6, taker2);
        assertEq(no30, 40e6, "buyNo: 40 NO>=30");
        // 40 YES sold into the 0.28 bid = 11.2 AUSD, minus the 0.1% fee = 11.1888
        assertEq(back30, 11_188_800, "buyNo: AUSD back from selling the YES leg");
        assertEq(a0 - AUSD.balanceOf(taker2), 40e6 - back30, "net NO cost");
        uint256 refund;
        (yes28, refund) = zap.buyYes(ids[0], markets[0], 30e6, 1, taker2);
        assertEq(refund, 0, "fully filled");
        assertApproxEqAbs(yes28, 36_548_780, 2, "30 AUSD at the 0.82 ask, minus fee");
        // a market that is not the series' own book is refused
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.MarketMismatch.selector, markets[1], markets[0]));
        zap.buyYes(ids[0], markets[1], 1e6, 1, taker2);
        vm.stopPrank();
        _assertZapEmpty();
    }

    function _requoteAndClose() internal {
        vm.startPrank(maker);
        uint40[] memory old = makerOrders;
        delete makerOrders;
        for (uint256 i; i < 3; ++i) {
            uint40[] memory cancel = new uint40[](2);
            (cancel[0], cancel[1]) = (old[2 * i], old[2 * i + 1]);
            _quote(markets[i], fv[i] - 100, fv[i] + 300, cancel); // "hourly" re-quote
        }
        vm.warp(dayEnd - 1 hours); // close: maker pulls every quote (Isotherm cannot pause a Kuru book)
        for (uint256 i; i < 3; ++i) {
            uint40[] memory cancel = new uint40[](2);
            (cancel[0], cancel[1]) = (makerOrders[2 * i], makerOrders[2 * i + 1]);
            IKuruBook(markets[i]).batchCancelOrdersNoRevert(cancel);
            (uint256 bid, uint256 ask) = IKuruBook(markets[i]).bestBidAsk();
            assertEq(bid, type(uint256).max, "book empty: no bids");
            assertEq(ask, 0, "book empty: no asks");
        }
        vm.stopPrank();
    }

    function _settle() internal {
        vm.warp(dayEnd + 10 minutes);
        assertEq(vault.duePendingLadders(0, 10).length, 3, "RCSS, RJTT and ZGSZ ladders are all due");
        assertTrue(_creReport("RCSS", date, 29, false, keccak256("e2e-settle")), "settle accepted");
        assertFalse(_creReport("RCSS", date, 35, false, keccak256("e2e-replay")), "second report rejected");
        assertTrue(_creReport("RJTT", date, 0, true, keccak256("e2e-void")), "void accepted");
        IIsothermResolver.Result memory r = resolver.resultOf("RCSS", date);
        assertEq(uint8(r.status), 1);
        assertEq(r.tmaxC, 29);
        vm.prank(taker1);
        vm.expectRevert(); // NotFinal: challenge window
        vault.redeem(ids[1], 1, 0);
        vm.warp(r.finalAt);
    }

    function _redeemSettled() internal {
        vm.prank(taker1);
        assertEq(vault.redeem(ids[1], yes29, 0), yes29, "taker1 YES>=29 pays 1 each");
        vm.startPrank(taker2);
        assertEq(vault.redeem(ids[2], 0, no30), no30, "taker2 NO>=30 pays 1 each (29 < 30)");
        assertEq(vault.redeem(ids[0], yes28, 0), yes28, "taker2 YES>=28 pays 1 each");
        vm.stopPrank();

        vm.startPrank(maker);
        address[] memory toks = new address[](4);
        toks[0] = address(AUSD);
        for (uint256 i; i < 3; ++i) toks[i + 1] = address(vault.getSeries(ids[i]).yes);
        MARGIN.batchWithdrawMaxTokens(toks);
        IERC20 no29 = IERC20(address(vault.getSeries(ids[1]).no));
        assertEq(vault.redeem(ids[1], 0, no29.balanceOf(maker)), 0, "losing NO>=29 pays 0");
        assertEq(no29.balanceOf(maker), 0, "losing tokens burned");
        for (uint256 i; i < 3; ++i) {
            StrikeFactory.Series memory s = vault.getSeries(ids[i]);
            uint256 y = IERC20(address(s.yes)).balanceOf(maker);
            uint256 n = IERC20(address(s.no)).balanceOf(maker);
            if (y + n > 0) vault.redeem(ids[i], y, n);
        }
        vm.stopPrank();
    }

    function _voidAndStale() internal {
        vm.startPrank(maker);
        assertEq(vault.redeem(voidId, 100e6, 0), 50e6, "void: YES pays 0.5");
        assertEq(vault.redeem(voidId, 0, 100e6), 50e6, "void: NO pays 0.5");
        vm.stopPrank();
        // nobody reported ZGSZ for 48h -> anyone may void it
        vm.warp(resolver.dayEnd("ZGSZ", date) + 48 hours);
        vm.prank(makeAddr("anyone"));
        resolver.voidIfStale("ZGSZ", date);
        vm.prank(maker);
        assertEq(vault.redeem(staleId, 10e6, 10e6), 10e6, "stale void: a full set still pays 1");
    }

    function _solvency() internal {
        uint256 sum;
        bytes32[5] memory all = [ids[0], ids[1], ids[2], voidId, staleId];
        for (uint256 i; i < all.length; ++i) {
            StrikeFactory.Series memory s = vault.getSeries(all[i]);
            (uint256 yh, uint256 nh) = vault.payoutHalves(all[i]);
            uint256 claims = (IERC20(address(s.yes)).totalSupply() * yh + IERC20(address(s.no)).totalSupply() * nh) / 2;
            assertGe(s.collateral, claims, "series solvent");
            sum += s.collateral;
            if (claims > 0) console2.log("series", i, "unclaimed winning claims (Kuru fee collector)", claims);
        }
        assertEq(AUSD.balanceOf(address(vault)), sum, "vault AUSD == sum(collateral)");
        _assertZapEmpty();
        console2.log("taker1 P&L (AUSD units)", int256(yes29) - 50e6);
        console2.log("taker2 NO>=30 cost / payout", 40e6 - back30, no30);
    }

    /// @notice Zap edge cases on a thin book: buyNo merges unsold YES back to AUSD (user never ends up holding YES),
    ///         buyYes refunds unspent AUSD, slippage bounds revert, and the Zap is left empty.
    function test_e2e_zapThinBook() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        date = _taipeiDate(block.timestamp + 1 days);
        int16[] memory one = new int16[](1);
        one[0] = 30;
        uint64 close = uint64(resolver.dayEnd("RCSS", date) - 1 hours);
        vm.prank(deployer);
        bytes32 id = vault.createLadder("RCSS", date, one, close)[0];
        uint64 closeTime = close;
        ids[0] = id;
        IERC20 yes = IERC20(address(vault.getSeries(id).yes));
        IERC20 no = IERC20(address(vault.getSeries(id).no));

        _faucet(maker);
        vm.startPrank(maker);
        AUSD.approve(address(vault), type(uint256).max);
        vault.mintSet(id, 100e6);
        address m = ROUTER.deployProxy(0, address(yes), address(AUSD), 1e6, 1e4, 10, 1e6, 1e12, 10, 0, 100);
        vm.stopPrank();
        vm.prank(deployer);
        zap.setCanonicalMarket(id, m);
        vm.startPrank(maker);
        AUSD.approve(address(MARGIN), type(uint256).max);
        yes.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(maker, address(AUSD), 50e6);
        MARGIN.deposit(maker, address(yes), 50e6);
        // only 10 YES each side: bid 0.30, ask 0.40
        uint32[] memory bp = new uint32[](1);
        uint96[] memory bs = new uint96[](1);
        uint32[] memory ap = new uint32[](1);
        uint96[] memory asz = new uint96[](1);
        (bp[0], bs[0], ap[0], asz[0]) = (3000, 10e6, 4000, 10e6);
        IKuruBook(m).batchUpdate(bp, bs, ap, asz, new uint40[](0), true);
        AUSD.transfer(taker2, 100e6);
        vm.stopPrank();

        vm.startPrank(taker2);
        AUSD.approve(address(zap), type(uint256).max);
        // slippage: asking for more AUSD back than the book can give reverts and moves nothing
        vm.expectRevert();
        zap.buyNo(id, m, 40e6, 33e6, taker2);
        uint256 a0 = AUSD.balanceOf(taker2);
        (uint256 noOut, uint256 back) = zap.buyNo(id, m, 40e6, 32e6, taker2);
        // 10 YES sold at 0.30 (-0.1% fee) = 2.997; 30 unsold YES merged with 30 NO back into 30 AUSD
        assertEq(noOut, 10e6, "only the sold YES leaves NO behind");
        assertEq(back, 2_997_000 + 30e6, "proceeds + merged unsold");
        assertEq(no.balanceOf(taker2), 10e6);
        assertEq(yes.balanceOf(taker2), 0, "user never ends up holding YES from buyNo");
        assertEq(a0 - AUSD.balanceOf(taker2), 40e6 - back, "net cost = 10 NO at 0.7003");

        a0 = AUSD.balanceOf(taker2);
        (uint256 yesOut, uint256 refund) = zap.buyYes(id, m, 10e6, 9e6, taker2);
        // 10 YES at 0.40 = 4 AUSD spent; 0.1% fee taken from the YES output; 6 AUSD refunded
        assertEq(yesOut, 9_990_000, "fill minus fee");
        assertEq(refund, 6e6, "unspent AUSD refunded");
        assertEq(a0 - AUSD.balanceOf(taker2), 4e6);
        vm.expectRevert(); // book now has no asks: a 1 YES minimum is unreachable
        zap.buyYes(id, m, 1e6, 1, taker2);
        vm.stopPrank();

        _thinSellYes(id, m, yes);
        _assertZapEmpty();
        _zapClosedAfter(id, m, closeTime);
        assertEq(AUSD.allowance(address(zap), m), 0, "no standing approval to the market");
        assertEq(yes.allowance(address(zap), m), 0, "no standing YES approval to the market");
    }

    /// @dev After closeTime the Zap refuses to trade (the outcome is close to known by then).
    function _zapClosedAfter(bytes32 id, address m, uint64 closeTime) internal {
        vm.warp(closeTime);
        vm.prank(taker2);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.TradingClosed.selector, id, closeTime));
        zap.sellYes(id, m, 1e6, 1, taker2);
    }

    /// @dev sellYes on a thin bid: 5 YES @0.25 resting, user sells 9.99 -> 5 sold, 4.99 refunded.
    function _thinSellYes(bytes32 id, address m, IERC20 yes) internal {
        uint32[] memory bp = new uint32[](1);
        uint96[] memory bs = new uint96[](1);
        (bp[0], bs[0]) = (2500, 5e6);
        vm.prank(maker);
        IKuruBook(m).batchUpdate(bp, bs, new uint32[](0), new uint96[](0), new uint40[](0), true);
        vm.startPrank(taker2);
        yes.approve(address(zap), type(uint256).max);
        uint256 a0 = AUSD.balanceOf(taker2);
        (uint256 ausdOut, uint256 yesBack) = zap.sellYes(id, m, 9_990_000, 1e6, taker2);
        assertEq(ausdOut, 1_248_750, "5 YES at 0.25 minus 0.1% fee");
        assertEq(yesBack, 4_990_000, "unsold YES refunded");
        assertEq(yes.balanceOf(taker2), 4_990_000);
        assertEq(AUSD.balanceOf(taker2) - a0, ausdOut);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------------------------------

    function _quote(address market, uint32 bid, uint32 ask, uint40[] memory cancel) internal {
        uint32[] memory bp = new uint32[](1);
        uint96[] memory bs = new uint96[](1);
        uint32[] memory ap = new uint32[](1);
        uint96[] memory asz = new uint96[](1);
        bp[0] = bid;
        bs[0] = 200e6;
        ap[0] = ask;
        asz[0] = 200e6;
        uint40 next = IKuruBook(market).s_orderIdCounter();
        IKuruBook(market).batchUpdate(bp, bs, ap, asz, cancel, true);
        makerOrders.push(next + 1);
        makerOrders.push(next + 2);
    }

    function _faucet(address to) internal {
        for (uint256 i; i < 3; ++i) {
            vm.prank(to);
            try FAUCET.requestFunds(to) {
                return;
            } catch {
                vm.warp(block.timestamp + 61); // global 60 s cooldown
            }
        }
        revert("faucet");
    }

    /// @dev Exactly what `cre workflow simulate --broadcast` sends: a 109-byte header (simulator constants) + payload,
    ///      a 96-byte report context and 4 signatures (ignored by the mock), from an arbitrary transmitter EOA.
    function _creReport(bytes4 station, uint32 d, int16 tmax, bool isVoid, bytes32 execId) internal returns (bool) {
        bytes32 src = keccak256(abi.encode("iem+awc", station, d, tmax));
        uint64 vu = uint64(block.timestamp + 30 minutes);
        (uint8 v, bytes32 rr, bytes32 ss) =
            vm.sign(ATTESTER_PK, resolver.settlementDigest(station, d, tmax, isVoid, src, vu));
        bytes memory payload = abi.encode(station, d, tmax, isVoid, src, vu, abi.encodePacked(rr, ss, v));
        bytes memory raw = abi.encodePacked(
            uint8(1),
            execId,
            uint32(100),
            uint32(1),
            uint32(1),
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes10("7721568293"),
            address(0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa),
            bytes2(0x0001),
            payload
        );
        bytes[] memory sigs = new bytes[](4);
        for (uint256 i; i < 4; ++i) sigs[i] = new bytes(65);
        vm.recordLogs();
        vm.prank(transmitter);
        MOCK_FWD.report(address(resolver), raw, new bytes(96), sigs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(MOCK_FWD) && logs[i].topics[0] == REPORT_PROCESSED) {
                return abi.decode(logs[i].data, (bool));
            }
        }
        revert("no ReportProcessed");
    }

    function _assertZapEmpty() internal view {
        assertEq(AUSD.balanceOf(address(zap)), 0, "zap holds no AUSD");
        for (uint256 i; i < 3; ++i) {
            if (ids[i] == bytes32(0)) continue;
            StrikeFactory.Series memory s = vault.getSeries(ids[i]);
            assertEq(IERC20(address(s.yes)).balanceOf(address(zap)), 0, "zap holds no YES");
            assertEq(IERC20(address(s.no)).balanceOf(address(zap)), 0, "zap holds no NO");
        }
    }

    function _taipeiDate(uint256 ts) internal pure returns (uint32) {
        uint256 z = (ts + 8 hours) / 1 days + 719_468; // civil_from_days (H. Hinnant)
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        uint256 y = yoe + era * 400 + (m <= 2 ? 1 : 0);
        return uint32(y * 10_000 + m * 100 + d);
    }
}
