// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {CollateralVault} from "./CollateralVault.sol";
import {StrikeFactory} from "./StrikeFactory.sol";
import {IKuruRouterView, IKuruOrderBookTaker} from "./interfaces/IKuru.sol";

/// @title IsothermZap (v1)
/// @notice One-transaction user flows on top of the per-strike Kuru v1 YES/AUSD books. Only YES has a book, so:
///           buyYes : AUSD -> YES on the book (IOC; unfilled AUSD refunded)
///           sellYes: YES -> AUSD on the book (IOC; unsold YES refunded)
///           buyNo  : mint a complete set with AUSD, sell the YES leg on the book, keep the NO. If the book cannot
///                    absorb every YES, the unsold YES is merged with the same amount of NO back into AUSD
///                    (vault.redeemSet), so the user never ends up holding YES from a "buy NO" click.
///         Users approve AUSD (and YES) to the Zap once, instead of once per Kuru market per day.
/// @dev Safety rules:
///      - Kuru v1 testnet market creation is permissionless, so anyone can list a second (hostile) book for our YES.
///        The Zap therefore only trades on the CANONICAL market of each series: write-once, set by a vault operator
///        (or the vault owner), and validated against Router.verifiedMarket at registration (base == series YES,
///        quote == vault collateral, 6/6 decimals, pricePrecision 1e4, sizePrecision 1e6, taker fee <= 30 bps,
///        maker fee <= taker fee). The `market` argument must equal it, so a UI bug cannot reroute funds.
///      - Every flow requires a non-zero min-out (clients compute it from Kuru's L2 book) and only trades before the
///        series' closeTime (after close the outcome is close to known; trade directly on Kuru at your own risk).
///      - Holds nothing between transactions; every function pulls only from msg.sender; approvals to the market are
///        exact and reset to 0.
contract IsothermZap is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Kuru price precision required of a canonical market (price unit 0.0001 AUSD).
    uint256 public constant PRICE_PRECISION = 1e4;
    /// @notice Kuru size precision required of a canonical market (1 size unit == 1 YES base unit, 6 dp).
    uint256 public constant SIZE_PRECISION = 1e6;
    /// @notice Highest Kuru taker fee a canonical market may charge (0.30%).
    uint256 public constant MAX_TAKER_FEE_BPS = 30;

    IKuruRouterView public immutable router;
    CollateralVault public immutable vault;
    IERC20 public immutable collateral;

    /// @notice The only Kuru market the Zap trades for a series (write-once).
    mapping(bytes32 seriesId => address market) public canonicalMarket;

    event CanonicalMarketSet(bytes32 indexed seriesId, address indexed market, address indexed setBy);
    event ZapBuyYes(
        address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 yesOut, uint256 ausdRefund
    );
    event ZapSellYes(
        address indexed user, bytes32 indexed seriesId, address market, uint256 yesIn, uint256 ausdOut, uint256 yesRefund
    );
    event ZapBuyNo(
        address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 noOut, uint256 ausdBack
    );

    error NotOperator();
    error CanonicalMarketAlreadySet(bytes32 seriesId, address market);
    error InvalidMarket(address market);
    error MarketMismatch(address market, address canonical);
    error TradingClosed(bytes32 seriesId, uint64 closeTime);
    error Slippage(uint256 got, uint256 min);
    error ZeroMinOut();
    error ZeroAmount();
    error ZeroAddress();

    struct Mkt {
        IERC20 yes;
        IERC20 no;
    }

    constructor(IKuruRouterView router_, CollateralVault vault_) {
        router = router_;
        vault = vault_;
        collateral = vault_.collateral();
    }

    // ---------------------------------------------------------------------------------------------
    // Market registry (operator, write-once)
    // ---------------------------------------------------------------------------------------------

    /// @notice Record the canonical Kuru YES/AUSD market of `seriesId`. Callable once per series by a vault operator
    ///         or the vault owner; the market must pass `validateMarket`.
    function setCanonicalMarket(bytes32 seriesId, address market) external {
        if (!vault.isOperator(msg.sender) && msg.sender != vault.owner()) revert NotOperator();
        address existing = canonicalMarket[seriesId];
        if (existing != address(0)) revert CanonicalMarketAlreadySet(seriesId, existing);
        if (!validateMarket(seriesId, market)) revert InvalidMarket(market);
        canonicalMarket[seriesId] = market;
        emit CanonicalMarketSet(seriesId, market, msg.sender);
    }

    /// @notice Whether `market` is acceptable as the canonical book of `seriesId` (see contract docs).
    function validateMarket(bytes32 seriesId, address market) public view returns (bool) {
        StrikeFactory.Series memory s = vault.getSeries(seriesId);
        if (address(s.yes) == address(0) || market == address(0)) return false;
        (
            uint32 pp,
            uint96 sp,
            address base,
            uint256 baseDec,
            address quote,
            uint256 quoteDec,,,,
            uint256 takerFee,
            uint256 makerFee
        ) = router.verifiedMarket(market);
        return base == address(s.yes) && quote == address(collateral) && baseDec == 6 && quoteDec == 6
            && pp == PRICE_PRECISION && sp == SIZE_PRECISION && takerFee <= MAX_TAKER_FEE_BPS && makerFee <= takerFee;
    }

    // ---------------------------------------------------------------------------------------------
    // User flows
    // ---------------------------------------------------------------------------------------------

    /// @notice Spend `ausdIn` AUSD on YES of `seriesId`. YES goes to `to`; unspent AUSD back to msg.sender.
    function buyYes(bytes32 seriesId, address market, uint256 ausdIn, uint256 minYesOut, address to)
        external
        nonReentrant
        returns (uint256 yesOut, uint256 ausdRefund)
    {
        if (ausdIn == 0) revert ZeroAmount();
        Mkt memory m = _market(seriesId, market, minYesOut, to);
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
        Mkt memory m = _market(seriesId, market, minAusdOut, to);
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
        Mkt memory m = _market(seriesId, market, minAusdBack, to);
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

    function _market(bytes32 seriesId, address market, uint256 minOut, address to)
        internal
        view
        returns (Mkt memory m)
    {
        if (minOut == 0) revert ZeroMinOut();
        if (to == address(0)) revert ZeroAddress();
        address canonical = canonicalMarket[seriesId];
        if (canonical == address(0) || market != canonical) revert MarketMismatch(market, canonical);
        StrikeFactory.Series memory s = vault.getSeries(seriesId);
        if (block.timestamp >= s.closeTime) revert TradingClosed(seriesId, s.closeTime);
        m = Mkt({yes: IERC20(address(s.yes)), no: IERC20(address(s.no))});
    }

    /// @dev Both tokens have 6 decimals (vault enforces it for collateral; OutcomeToken is 6 dp).
    function _buy(address market, Mkt memory m, uint256 ausdIn) internal returns (uint256 yesOut, uint256 refund) {
        uint256 yesBefore = m.yes.balanceOf(address(this));
        uint256 ausdBefore = collateral.balanceOf(address(this)) - ausdIn; // what the zap held before this call
        uint256 quoteSize = ausdIn * PRICE_PRECISION / 1e6;
        collateral.forceApprove(market, ausdIn);
        IKuruOrderBookTaker(market).placeAndExecuteMarketBuy(SafeCast.toUint96(quoteSize), 0, false, false);
        collateral.forceApprove(market, 0);
        yesOut = m.yes.balanceOf(address(this)) - yesBefore;
        refund = collateral.balanceOf(address(this)) - ausdBefore;
    }

    function _sell(address market, Mkt memory m, uint256 yesIn) internal returns (uint256 ausdOut, uint256 refund) {
        uint256 ausdBefore = collateral.balanceOf(address(this));
        uint256 yesBefore = m.yes.balanceOf(address(this)) - yesIn;
        uint256 size = yesIn * SIZE_PRECISION / 1e6;
        m.yes.forceApprove(market, yesIn);
        IKuruOrderBookTaker(market).placeAndExecuteMarketSell(SafeCast.toUint96(size), 0, false, false);
        m.yes.forceApprove(market, 0);
        ausdOut = collateral.balanceOf(address(this)) - ausdBefore;
        refund = m.yes.balanceOf(address(this)) - yesBefore;
    }
}
