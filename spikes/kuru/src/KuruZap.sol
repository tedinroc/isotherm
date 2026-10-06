// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IKuruOrderBook} from "./interfaces/IKuru.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface ICompleteSet {
    function collateral() external view returns (address);
    function yes() external view returns (address);
    function no() external view returns (address);
    function mint(address to, uint256 amount) external;
}

/// @title KuruZap (spike)
/// @notice Proves a contract can act as TAKER on a Kuru v1 order book on behalf of a user.
///         Kuru credits market-order output to `_msgSender()` (= this contract) when `_isMargin=false`,
///         so the zap forwards outputs and any unspent input back to the user using balance deltas.
/// Approvals needed by the USER: collateral (AUSD) or YES -> this zap.
/// Approvals done by the ZAP: AUSD/YES -> market (the OrderBook pulls with transferFrom into MarginAccount),
///                             AUSD -> complete-set minter (buyNo only).
contract KuruZap {
    error Slippage();

    event ZapBuyYes(address indexed user, address indexed market, uint256 ausdIn, uint256 yesOut, uint256 ausdRefund);
    event ZapSellYes(address indexed user, address indexed market, uint256 yesIn, uint256 ausdOut, uint256 yesRefund);
    event ZapBuyNo(address indexed user, address indexed market, uint256 ausdIn, uint256 noOut, uint256 ausdBack);

    struct P {
        uint32 pricePrecision;
        uint96 sizePrecision;
        address base;
        uint256 baseDecimals;
        address quote;
        uint256 quoteDecimals;
    }

    function _params(address market) internal view returns (P memory p) {
        (p.pricePrecision, p.sizePrecision, p.base, p.baseDecimals, p.quote, p.quoteDecimals,,,,,) =
            IKuruOrderBook(market).getMarketParams();
    }

    /// @notice Spend `ausdIn` of quote on `market` (IOC). Unfilled quote is refunded.
    function buyYes(address market, uint256 ausdIn, uint256 minYesOut, address to)
        external
        returns (uint256 yesOut, uint256 refund)
    {
        P memory p = _params(market);
        _pull(p.quote, msg.sender, ausdIn);
        (yesOut, refund) = _marketBuy(market, p, ausdIn);
        if (yesOut < minYesOut) revert Slippage();
        _push(p.base, to, yesOut);
        if (refund > 0) _push(p.quote, msg.sender, refund);
        emit ZapBuyYes(msg.sender, market, ausdIn, yesOut, refund);
    }

    /// @notice Sell `yesIn` YES on `market` (IOC). Unsold YES is refunded.
    function sellYes(address market, uint256 yesIn, uint256 minAusdOut, address to)
        external
        returns (uint256 ausdOut, uint256 refund)
    {
        P memory p = _params(market);
        _pull(p.base, msg.sender, yesIn);
        (ausdOut, refund) = _marketSell(market, p, yesIn);
        if (ausdOut < minAusdOut) revert Slippage();
        _push(p.quote, to, ausdOut);
        if (refund > 0) _push(p.base, msg.sender, refund);
        emit ZapSellYes(msg.sender, market, yesIn, ausdOut, refund);
    }

    /// @notice Only YES has a book. "Buy NO" = mint a complete set with `ausdIn`, market-sell the YES leg,
    ///         return NO + the AUSD proceeds (+ any unsold YES). Net NO cost = ausdIn - ausdBack.
    function buyNo(address set, address market, uint256 ausdIn, uint256 minAusdBack, address to)
        external
        returns (uint256 noOut, uint256 ausdBack)
    {
        P memory p = _params(market);
        address collateral = ICompleteSet(set).collateral();
        require(collateral == p.quote && ICompleteSet(set).yes() == p.base, "set/market mismatch");
        _pull(collateral, msg.sender, ausdIn);
        IERC20Min(collateral).approve(set, ausdIn);
        ICompleteSet(set).mint(address(this), ausdIn);
        uint256 unsoldYes;
        (ausdBack, unsoldYes) = _marketSell(market, p, ausdIn);
        if (ausdBack < minAusdBack) revert Slippage();
        noOut = ausdIn;
        _push(ICompleteSet(set).no(), to, noOut);
        _push(collateral, to, ausdBack);
        if (unsoldYes > 0) _push(p.base, to, unsoldYes);
        emit ZapBuyNo(msg.sender, market, ausdIn, noOut, ausdBack);
    }

    // ---------------------------------------------------------------------------------------------

    function _marketBuy(address market, P memory p, uint256 ausdIn) internal returns (uint256 out, uint256 refund) {
        uint256 baseBefore = IERC20Min(p.base).balanceOf(address(this));
        uint256 quoteBefore = IERC20Min(p.quote).balanceOf(address(this));
        // quote amount in pricePrecision units; Kuru pulls quoteSize * 10^quoteDecimals / pricePrecision
        uint256 quoteSize = ausdIn * p.pricePrecision / (10 ** p.quoteDecimals);
        IERC20Min(p.quote).approve(market, ausdIn);
        IKuruOrderBook(market).placeAndExecuteMarketBuy(uint96(quoteSize), 0, false, false);
        IERC20Min(p.quote).approve(market, 0);
        out = IERC20Min(p.base).balanceOf(address(this)) - baseBefore;
        // after the call the zap holds (quoteBefore - pulled + refunded); everything it holds belongs to the user
        refund = IERC20Min(p.quote).balanceOf(address(this)) - (quoteBefore - ausdIn);
    }

    function _marketSell(address market, P memory p, uint256 yesIn) internal returns (uint256 out, uint256 refund) {
        uint256 quoteBefore = IERC20Min(p.quote).balanceOf(address(this));
        uint256 baseBefore = IERC20Min(p.base).balanceOf(address(this));
        uint256 size = yesIn * p.sizePrecision / (10 ** p.baseDecimals);
        IERC20Min(p.base).approve(market, yesIn);
        IKuruOrderBook(market).placeAndExecuteMarketSell(uint96(size), 0, false, false);
        IERC20Min(p.base).approve(market, 0);
        out = IERC20Min(p.quote).balanceOf(address(this)) - quoteBefore;
        refund = IERC20Min(p.base).balanceOf(address(this)) - (baseBefore - yesIn);
    }

    function _pull(address t, address from, uint256 amt) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, from, address(this), amt));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "pull");
    }

    function _push(address t, address to, uint256 amt) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amt));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "push");
    }
}
