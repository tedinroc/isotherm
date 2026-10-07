// SPDX-License-Identifier: GPL-2.0-or-later
// The inline IKuruRouterView and IKuruOrderBookTaker declarations below are the same declarations as in
// spikes/kuru/src/interfaces/IKuru.sol, derived from github.com/Kuru-Labs/Kuru-contracts-dex-public
// (contracts/interfaces/IRouter.sol + IOrderBook.sol, commit 2060bb2, GPL-2.0-or-later), so this file is labelled
// GPL-2.0-or-later as a whole. Full license text: LICENSES/GPL-2.0-or-later.txt at the repository root.
// Relabelled from "MIT" on 2026-10-07; only this header changed (feasibility-build evidence, otherwise unchanged).
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {CollateralVault} from "../../../src/CollateralVault.sol";
import {StrikeFactory} from "../../../src/StrikeFactory.sol";

/// @dev Minimal Kuru v1 surface used here (selectors checked against the live Monad-testnet bytecode by the Kuru spike).
interface IKuruRouterView {
    function verifiedMarket(address market)
        external
        view
        returns (
            uint32 pricePrecision,
            uint96 sizePrecision,
            address baseAssetAddress,
            uint256 baseAssetDecimals,
            address quoteAssetAddress,
            uint256 quoteAssetDecimals,
            uint32 tickSize,
            uint96 minSize,
            uint96 maxSize,
            uint256 takerFeeBps,
            uint256 makerFeeBps
        );
}

interface IKuruOrderBookTaker {
    /// `quoteSize` in pricePrecision units; `isMargin=false` pulls quote from msg.sender and pays base to msg.sender.
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
    /// `size` in sizePrecision units; pays quote to msg.sender.
    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
}

/// @title IsothermZap
/// @notice One-transaction user flows on top of the per-strike Kuru v1 YES/AUSD books. Only YES has a book, so:
///           buyYes : AUSD -> YES on the book (IOC; unfilled AUSD refunded)
///           sellYes: YES -> AUSD on the book (IOC; unsold YES refunded)
///           buyNo  : mint a complete set with AUSD, sell the YES leg on the book, keep the NO.
///                    Net NO price = 1 - (YES bid after fee). If the book is too thin to absorb every YES, the unsold
///                    YES is merged with the same amount of NO back into AUSD (vault.redeemSet), so the user never ends
///                    up holding YES from a "buy NO" click.
///         Why a zap at all: Kuru markets are new contracts every day (one per strike), so a direct trade needs a fresh
///         ERC-20 approval per market per day. With the zap the user approves AUSD (and YES/NO) once, forever.
/// @dev Holds nothing between transactions. Every function pulls only from msg.sender. The market is checked against
///      Kuru's own Router registry (`verifiedMarket`) and must be the YES/collateral book of `seriesId`, so a UI cannot
///      route a user's funds into an unverified or mismatched market. Approvals to the market are exact and reset.
contract IsothermZap is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IKuruRouterView public immutable router;
    CollateralVault public immutable vault;
    IERC20 public immutable collateral;

    event ZapBuyYes(
        address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 yesOut, uint256 ausdRefund
    );
    event ZapSellYes(
        address indexed user, bytes32 indexed seriesId, address market, uint256 yesIn, uint256 ausdOut, uint256 yesRefund
    );
    event ZapBuyNo(
        address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 noOut, uint256 ausdBack
    );

    error MarketMismatch(address market);
    error Slippage(uint256 got, uint256 min);
    error ZeroAmount();

    struct Mkt {
        uint256 pricePrecision;
        uint256 sizePrecision;
        IERC20 yes;
        IERC20 no;
    }

    constructor(IKuruRouterView router_, CollateralVault vault_) {
        router = router_;
        vault = vault_;
        collateral = vault_.collateral();
    }

    /// @notice Spend `ausdIn` AUSD on YES of `seriesId`. YES goes to `to`; unspent AUSD back to msg.sender.
    function buyYes(bytes32 seriesId, address market, uint256 ausdIn, uint256 minYesOut, address to)
        external
        nonReentrant
        returns (uint256 yesOut, uint256 ausdRefund)
    {
        if (ausdIn == 0) revert ZeroAmount();
        Mkt memory m = _market(seriesId, market);
        collateral.safeTransferFrom(msg.sender, address(this), ausdIn);
        (yesOut, ausdRefund) = _buy(market, m, ausdIn);
        if (yesOut < minYesOut) revert Slippage(yesOut, minYesOut);
        m.yes.safeTransfer(to, yesOut);
        if (ausdRefund != 0) collateral.safeTransfer(msg.sender, ausdRefund);
        emit ZapBuyYes(msg.sender, seriesId, market, ausdIn, yesOut, ausdRefund);
    }

    /// @notice Sell `yesIn` YES of `seriesId`. AUSD goes to `to`; unsold YES back to msg.sender.
    function sellYes(bytes32 seriesId, address market, uint256 yesIn, uint256 minAusdOut, address to)
        external
        nonReentrant
        returns (uint256 ausdOut, uint256 yesRefund)
    {
        if (yesIn == 0) revert ZeroAmount();
        Mkt memory m = _market(seriesId, market);
        m.yes.safeTransferFrom(msg.sender, address(this), yesIn);
        (ausdOut, yesRefund) = _sell(market, m, yesIn);
        if (ausdOut < minAusdOut) revert Slippage(ausdOut, minAusdOut);
        collateral.safeTransfer(to, ausdOut);
        if (yesRefund != 0) m.yes.safeTransfer(msg.sender, yesRefund);
        emit ZapSellYes(msg.sender, seriesId, market, yesIn, ausdOut, yesRefund);
    }

    /// @notice Mint `ausdIn` complete sets, sell the YES leg on the book. `to` receives the NO and the AUSD proceeds
    ///         (plus AUSD from merging any unsold YES back). minAusdBack bounds the effective NO price:
    ///         price per NO = (ausdIn - ausdBack) / noOut.
    function buyNo(bytes32 seriesId, address market, uint256 ausdIn, uint256 minAusdBack, address to)
        external
        nonReentrant
        returns (uint256 noOut, uint256 ausdBack)
    {
        if (ausdIn == 0) revert ZeroAmount();
        Mkt memory m = _market(seriesId, market);
        collateral.safeTransferFrom(msg.sender, address(this), ausdIn);
        collateral.forceApprove(address(vault), ausdIn);
        vault.mintSetTo(seriesId, ausdIn, address(this));

        (uint256 proceeds, uint256 unsoldYes) = _sell(market, m, ausdIn);
        noOut = ausdIn - unsoldYes;
        ausdBack = proceeds + unsoldYes;
        if (unsoldYes != 0) vault.redeemSet(seriesId, unsoldYes); // merge YES+NO back into AUSD (1:1)
        if (ausdBack < minAusdBack) revert Slippage(ausdBack, minAusdBack);

        if (noOut != 0) m.no.safeTransfer(to, noOut);
        if (ausdBack != 0) collateral.safeTransfer(to, ausdBack);
        emit ZapBuyNo(msg.sender, seriesId, market, ausdIn, noOut, ausdBack);
    }

    // ---------------------------------------------------------------------------------------------

    function _market(bytes32 seriesId, address market) internal view returns (Mkt memory m) {
        StrikeFactory.Series memory s = vault.getSeries(seriesId);
        (uint32 pp, uint96 sp, address base,, address quote,,,,,,) = router.verifiedMarket(market);
        if (address(s.yes) == address(0) || base != address(s.yes) || quote != address(collateral)) {
            revert MarketMismatch(market);
        }
        m = Mkt({pricePrecision: pp, sizePrecision: sp, yes: IERC20(address(s.yes)), no: IERC20(address(s.no))});
    }

    /// @dev Both tokens have 6 decimals (vault enforces it for collateral; OutcomeToken is 6 dp).
    function _buy(address market, Mkt memory m, uint256 ausdIn) internal returns (uint256 yesOut, uint256 refund) {
        uint256 yesBefore = m.yes.balanceOf(address(this));
        uint256 ausdBefore = collateral.balanceOf(address(this)) - ausdIn; // what the zap held before this call
        uint256 quoteSize = ausdIn * m.pricePrecision / 1e6;
        collateral.forceApprove(market, ausdIn);
        IKuruOrderBookTaker(market).placeAndExecuteMarketBuy(SafeCast.toUint96(quoteSize), 0, false, false);
        collateral.forceApprove(market, 0);
        yesOut = m.yes.balanceOf(address(this)) - yesBefore;
        refund = collateral.balanceOf(address(this)) - ausdBefore;
    }

    function _sell(address market, Mkt memory m, uint256 yesIn) internal returns (uint256 ausdOut, uint256 refund) {
        uint256 ausdBefore = collateral.balanceOf(address(this));
        uint256 yesBefore = m.yes.balanceOf(address(this)) - yesIn;
        uint256 size = yesIn * m.sizePrecision / 1e6;
        m.yes.forceApprove(market, yesIn);
        IKuruOrderBookTaker(market).placeAndExecuteMarketSell(SafeCast.toUint96(size), 0, false, false);
        m.yes.forceApprove(market, 0);
        ausdOut = collateral.balanceOf(address(this)) - ausdBefore;
        refund = m.yes.balanceOf(address(this)) - yesBefore;
    }
}
