// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IKuruRouter, IKuruOrderBook, IKuruMarginAccount} from "./interfaces/IKuru.sol";
import {SpikeToken} from "./SpikeToken.sol";

interface IAusdFaucet {
    function requestFunds(address) external;
}

interface IERC20P {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice A dumb account controlled by LiveProbe so maker and taker are DIFFERENT addresses.
contract Actor {
    address immutable boss;

    constructor() {
        boss = msg.sender;
    }

    function exec(address to, bytes calldata data) external returns (bytes memory r) {
        require(msg.sender == boss, "boss");
        bool ok;
        (ok, r) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}

/// @notice Runs the whole YES/AUSD lifecycle inside ONE eth_call against LIVE Monad testnet state, by being
///         injected with a state override (no MON, no tx, nothing persisted). Proves the deployed v1 Router,
///         MarginAccount, OrderBook implementation and the AUSD faucet all still work today.
contract LiveProbe {
    struct Report {
        address market;
        address yes;
        address maker;
        address taker;
        uint256 gasCreateMarket;
        uint256 gasMakerDeposit;
        uint256 gasPlaceBid;
        uint256 gasPlaceAsk;
        uint256 gasBatchUpdate6;
        uint256 gasTakerMarketBuy;
        uint256 gasTakerMarketSell;
        uint256 gasCancelAll;
        uint256 takerYesReceived;
        uint256 takerAusdReceived;
        uint256 bestBidAfterQuotes;
        uint256 bestAskAfterQuotes;
        bytes l2BookAfterRequote;
        bytes l2BookAfterCancel;
        uint40 orderIdCounter;
    }

    // Isotherm v1 YES/AUSD market params (see RESULT.md for the rationale).
    uint96 constant SIZE_PRECISION = 1e6; // 1 size unit = 1 YES base unit (6 dp)
    uint32 constant PRICE_PRECISION = 1e4; // price 0.5500 AUSD -> 5500
    uint32 constant TICK = 10; // 0.001 AUSD
    uint96 constant MIN_SIZE = 1e6; // 1 YES
    uint96 constant MAX_SIZE = 1e12; // 1,000,000 YES
    uint256 constant TAKER_BPS = 10;
    uint256 constant MAKER_BPS = 0;
    uint96 constant AMM_SPREAD = 100; // vault unused, but must be >0, %10==0, <500

    function run(address router, address ausd, address faucet) external returns (Report memory rep) {
        IKuruRouter R = IKuruRouter(router);
        IKuruMarginAccount MA = IKuruMarginAccount(R.marginAccountAddress());
        Actor maker = new Actor();
        Actor taker = new Actor();
        rep.maker = address(maker);
        rep.taker = address(taker);

        // AUSD from the real faucet (10,000 AUSD per drip) -> split between maker and taker
        IAusdFaucet(faucet).requestFunds(address(this));
        IERC20P(ausd).transfer(address(maker), 5_000e6);
        IERC20P(ausd).transfer(address(taker), 5_000e6);

        SpikeToken yes = new SpikeToken("YES RCSS Tmax>=30C 2026-10-08", "YES", address(this));
        yes.mint(address(maker), 1_000e6);
        yes.mint(address(taker), 100e6);
        rep.yes = address(yes);

        uint256 g = gasleft();
        address m = R.deployProxy(
            0, address(yes), ausd, SIZE_PRECISION, PRICE_PRECISION, TICK, MIN_SIZE, MAX_SIZE, TAKER_BPS, MAKER_BPS, AMM_SPREAD
        );
        rep.gasCreateMarket = g - gasleft();
        rep.market = m;

        // maker: approve + deposit both legs into the MarginAccount
        maker.exec(ausd, abi.encodeCall(IERC20P.approve, (address(MA), type(uint256).max)));
        maker.exec(address(yes), abi.encodeCall(IERC20P.approve, (address(MA), type(uint256).max)));
        g = gasleft();
        maker.exec(address(MA), abi.encodeCall(IKuruMarginAccount.deposit, (address(maker), ausd, 2_000e6)));
        rep.gasMakerDeposit = g - gasleft();
        maker.exec(address(MA), abi.encodeCall(IKuruMarginAccount.deposit, (address(maker), address(yes), 1_000e6)));

        // single resting bid 0.540 x 50 and ask 0.560 x 50 (post-only)
        g = gasleft();
        maker.exec(m, abi.encodeCall(IKuruOrderBook.addBuyOrder, (5400, 50e6, true)));
        rep.gasPlaceBid = g - gasleft();
        g = gasleft();
        maker.exec(m, abi.encodeCall(IKuruOrderBook.addSellOrder, (5600, 50e6, true)));
        rep.gasPlaceAsk = g - gasleft();
        (rep.bestBidAfterQuotes, rep.bestAskAfterQuotes) = IKuruOrderBook(m).bestBidAsk();

        // batch re-quote: cancel both, place 3 bids + 3 asks
        {
            uint32[] memory bp = new uint32[](3);
            uint96[] memory bs = new uint96[](3);
            uint32[] memory ap = new uint32[](3);
            uint96[] memory as_ = new uint96[](3);
            (bp[0], bp[1], bp[2]) = (5450, 5400, 5350);
            (ap[0], ap[1], ap[2]) = (5550, 5600, 5650);
            for (uint256 i; i < 3; i++) {
                bs[i] = 100e6;
                as_[i] = 100e6;
            }
            uint40[] memory cancel = new uint40[](2);
            (cancel[0], cancel[1]) = (1, 2);
            g = gasleft();
            maker.exec(m, abi.encodeCall(IKuruOrderBook.batchUpdate, (bp, bs, ap, as_, cancel, true)));
            rep.gasBatchUpdate6 = g - gasleft();
        }

        // taker: market buy 100 AUSD of YES (IOC, wallet-to-wallet, no margin account)
        taker.exec(ausd, abi.encodeCall(IERC20P.approve, (m, type(uint256).max)));
        uint256 y0 = yes.balanceOf(address(taker));
        g = gasleft();
        taker.exec(m, abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketBuy, (uint96(100 * 1e4), 0, false, false)));
        rep.gasTakerMarketBuy = g - gasleft();
        rep.takerYesReceived = yes.balanceOf(address(taker)) - y0;

        // taker: market sell 20 YES
        taker.exec(address(yes), abi.encodeCall(IERC20P.approve, (m, type(uint256).max)));
        uint256 a0 = IERC20P(ausd).balanceOf(address(taker));
        g = gasleft();
        taker.exec(m, abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketSell, (uint96(20e6), 0, false, false)));
        rep.gasTakerMarketSell = g - gasleft();
        rep.takerAusdReceived = IERC20P(ausd).balanceOf(address(taker)) - a0;

        rep.l2BookAfterRequote = IKuruOrderBook(m).getL2Book();

        // cancel everything still resting (ids 3..8); filled ids are skipped by the NoRevert variant
        {
            uint40[] memory ids = new uint40[](6);
            for (uint40 i; i < 6; i++) {
                ids[i] = 3 + i;
            }
            g = gasleft();
            maker.exec(m, abi.encodeCall(IKuruOrderBook.batchCancelOrdersNoRevert, (ids)));
            rep.gasCancelAll = g - gasleft();
        }
        rep.l2BookAfterCancel = IKuruOrderBook(m).getL2Book();
        rep.orderIdCounter = IKuruOrderBook(m).s_orderIdCounter();
    }
}
