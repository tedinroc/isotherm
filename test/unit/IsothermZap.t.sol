// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IsoTest} from "../utils/IsoTest.sol";
import {IsothermZap} from "../../src/IsothermZap.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IKuruRouterView} from "../../src/interfaces/IKuru.sol";

/// @dev Offline stand-in for Kuru v1: a Router registry (`verifiedMarket`) and a fixed-price IOC book that fills up to
///      its inventory, pulling the input with transferFrom and paying the output by transfer to msg.sender (the same
///      token flow the live OrderBook uses with isMargin = false). Live Kuru behaviour is covered by the fork tests.
contract MockKuruRouter {
    struct Info {
        uint32 pp;
        uint96 sp;
        address base;
        uint256 baseDec;
        address quote;
        uint256 quoteDec;
        uint256 takerFee;
        uint256 makerFee;
    }

    mapping(address => Info) public info;

    function set(address m, Info memory i) external {
        info[m] = i;
    }

    function verifiedMarket(address m)
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        Info memory i = info[m];
        return (i.pp, i.sp, i.base, i.baseDec, i.quote, i.quoteDec, 10, 1e6, 1e12, i.takerFee, i.makerFee);
    }
}

contract MockBook {
    IERC20 public immutable base;
    IERC20 public immutable quote;
    uint256 public askPrice; // 1e4 precision
    uint256 public bidPrice;

    constructor(IERC20 b, IERC20 q, uint256 ask, uint256 bid) {
        (base, quote, askPrice, bidPrice) = (b, q, ask, bid);
    }

    /// quoteSize in 1e4 units; fills as much as the YES inventory allows, refunds the rest.
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256, bool, bool) external payable returns (uint256) {
        uint256 ausdIn = uint256(quoteSize) * 100;
        quote.transferFrom(msg.sender, address(this), ausdIn);
        uint256 yesOut = ausdIn * 1e4 / askPrice;
        uint256 inv = base.balanceOf(address(this));
        if (yesOut > inv) yesOut = inv;
        uint256 spent = yesOut * askPrice / 1e4;
        base.transfer(msg.sender, yesOut);
        if (ausdIn > spent) quote.transfer(msg.sender, ausdIn - spent);
        return yesOut;
    }

    function placeAndExecuteMarketSell(uint96 size, uint256, bool, bool) external payable returns (uint256) {
        base.transferFrom(msg.sender, address(this), size);
        uint256 out = uint256(size) * bidPrice / 1e4;
        uint256 inv = quote.balanceOf(address(this));
        uint256 sold = size;
        if (out > inv) {
            out = inv;
            sold = out * 1e4 / bidPrice;
            base.transfer(msg.sender, size - sold);
        }
        quote.transfer(msg.sender, out);
        return out;
    }
}

contract IsothermZapTest is IsoTest {
    MockKuruRouter internal router;
    IsothermZap internal zap;
    bytes32 internal id;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    MockBook internal book;

    function setUp() public override {
        super.setUp();
        router = new MockKuruRouter();
        zap = new IsothermZap(IKuruRouterView(address(router)), vault);
        id = _create(RCSS, D, 30);
        (yes, no) = _tokens(id);
        book = _book(5000, 4000, 10);
        // liquidity: 100 YES on the ask, 100 AUSD for the bid
        _mint(address(this), id, 100e6);
        yes.transfer(address(book), 100e6);
        ausd.mint(address(book), 100e6);
    }

    function _book(uint256 ask, uint256 bid, uint256 fee) internal returns (MockBook b) {
        b = new MockBook(IERC20(address(yes)), ausd, ask, bid);
        router.set(
            address(b),
            MockKuruRouter.Info({
                pp: 1e4,
                sp: 1e6,
                base: address(yes),
                baseDec: 6,
                quote: address(ausd),
                quoteDec: 6,
                takerFee: fee,
                makerFee: 0
            })
        );
    }

    function _register() internal {
        vm.prank(operator);
        zap.setCanonicalMarket(id, address(book));
    }

    // --- registry ----------------------------------------------------------------------------------

    function test_registryAccessAndWriteOnce() public {
        vm.prank(alice);
        vm.expectRevert(IsothermZap.NotOperator.selector);
        zap.setCanonicalMarket(id, address(book));
        vm.expectEmit(address(zap));
        emit IsothermZap.CanonicalMarketSet(id, address(book), operator);
        _register();
        assertEq(zap.canonicalMarket(id), address(book));
        MockBook other = _book(5000, 4000, 10);
        vm.prank(owner); // the owner is implicitly an operator, but the slot is write-once
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.CanonicalMarketAlreadySet.selector, id, address(book)));
        zap.setCanonicalMarket(id, address(other));
        bytes32 id2 = _create(RCSS, D, 31);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.InvalidMarket.selector, address(other)));
        zap.setCanonicalMarket(id2, address(other)); // wrong base token for this series
    }

    function test_validateMarketRejectsEveryBadParameter() public {
        assertTrue(zap.validateMarket(id, address(book)));
        assertFalse(zap.validateMarket(bytes32(uint256(1)), address(book)), "unknown series");
        assertFalse(zap.validateMarket(id, address(0)), "zero market");
        assertFalse(zap.validateMarket(id, makeAddr("unregistered")), "not a verified market");
        address m = makeAddr("m");
        router.set(m, _goodInfo());
        assertTrue(zap.validateMarket(id, m), "30 bps is the cap");
        for (uint256 i; i < 8; ++i) {
            MockKuruRouter.Info memory bad = _goodInfo(); // fresh copy each round (memory structs alias)
            if (i == 0) bad.base = address(no);
            if (i == 1) bad.quote = address(yes);
            if (i == 2) bad.pp = 1e3;
            if (i == 3) bad.sp = 1e5;
            if (i == 4) bad.baseDec = 18;
            if (i == 5) bad.quoteDec = 18;
            if (i == 6) bad.takerFee = 31;
            if (i == 7) bad.makerFee = 31; // maker > taker
            router.set(m, bad);
            assertFalse(zap.validateMarket(id, m), vm.toString(i));
        }
    }

    function _goodInfo() internal view returns (MockKuruRouter.Info memory) {
        return MockKuruRouter.Info({
            pp: 1e4, sp: 1e6, base: address(yes), baseDec: 6, quote: address(ausd), quoteDec: 6, takerFee: 30, makerFee: 0
        });
    }

    // --- trade guards ------------------------------------------------------------------------------

    function test_tradeGuards() public {
        _fund(alice, 100e6);
        vm.prank(alice);
        ausd.approve(address(zap), type(uint256).max);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.MarketMismatch.selector, address(book), address(0)));
        zap.buyYes(id, address(book), 10e6, 1, alice); // no canonical market yet
        vm.stopPrank();
        _register();
        MockBook hostile = _book(5000, 4000, 9000);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.MarketMismatch.selector, address(hostile), address(book)));
        zap.buyYes(id, address(hostile), 10e6, 1, alice);
        vm.expectRevert(IsothermZap.ZeroMinOut.selector);
        zap.buyYes(id, address(book), 10e6, 0, alice);
        vm.expectRevert(IsothermZap.ZeroMinOut.selector);
        zap.sellYes(id, address(book), 1e6, 0, alice);
        vm.expectRevert(IsothermZap.ZeroMinOut.selector);
        zap.buyNo(id, address(book), 10e6, 0, alice);
        vm.expectRevert(IsothermZap.ZeroAmount.selector);
        zap.buyYes(id, address(book), 0, 1, alice);
        vm.expectRevert(IsothermZap.ZeroAddress.selector);
        zap.buyYes(id, address(book), 10e6, 1, address(0));
        vm.stopPrank();

        uint64 close = vault.getSeries(id).closeTime;
        vm.warp(close);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.TradingClosed.selector, id, close));
        zap.buyYes(id, address(book), 10e6, 1, alice);
    }

    // --- flows -------------------------------------------------------------------------------------

    function test_buyYesSellYesBuyNo() public {
        _register();
        _fund(alice, 100e6);
        vm.startPrank(alice);
        ausd.approve(address(zap), type(uint256).max);
        yes.approve(address(zap), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(IsothermZap.Slippage.selector, 20e6, 21e6));
        zap.buyYes(id, address(book), 10e6, 21e6, alice);
        (uint256 y, uint256 refund) = zap.buyYes(id, address(book), 10e6, 20e6, alice); // 10 AUSD @ 0.50
        assertEq(y, 20e6);
        assertEq(refund, 0);
        (uint256 a, uint256 yBack) = zap.sellYes(id, address(book), 10e6, 4e6, bob); // 10 YES @ 0.40 -> bob
        assertEq(a, 4e6);
        assertEq(yBack, 0);
        assertEq(ausd.balanceOf(bob), 4e6);
        (uint256 n, uint256 back) = zap.buyNo(id, address(book), 10e6, 4e6, alice); // mint 10, sell 10 YES @ 0.40
        assertEq(n, 10e6);
        assertEq(back, 4e6);
        assertEq(no.balanceOf(alice), 10e6);
        vm.stopPrank();
        assertEq(ausd.balanceOf(address(zap)), 0);
        assertEq(yes.balanceOf(address(zap)), 0);
        assertEq(no.balanceOf(address(zap)), 0);
        assertEq(ausd.allowance(address(zap), address(book)), 0);
    }
}
