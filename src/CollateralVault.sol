// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {StrikeFactory} from "./StrikeFactory.sol";
import {IIsothermResolver} from "./interfaces/IIsothermResolver.sol";

/// @title Isotherm CollateralVault
/// @notice Fully collateralised complete sets: 1 AUSD in = 1 YES + 1 NO out. Every set is worth exactly 1 AUSD in
///         every outcome:
///           Settled, tmaxC >= strike : YES pays 1, NO pays 0
///           Settled, tmaxC <  strike : YES pays 0, NO pays 1
///           Void                     : YES pays 0.5, NO pays 0.5 (rounded down per redemption call)
///         Collateral is tracked per series (`Series.collateral`) and every payout is subtracted with checked math,
///         so a series can never pay out more than was deposited into it.
/// @dev Assumes `collateral` is a plain 6-decimal ERC-20 without transfer fees or rebasing (AUSD).
///      Admin powers: owner/operators create series; guardian/owner pause *new minting* only. Exits are never
///      pausable: `redeemSet` works at any time and `redeem` works as soon as the Resolver has a result.
contract CollateralVault is StrikeFactory, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public immutable collateral;
    address public guardian;

    event GuardianUpdated(address indexed previous, address indexed current);
    event SetMinted(bytes32 indexed seriesId, address indexed payer, address indexed to, uint256 amount);
    event SetRedeemed(bytes32 indexed seriesId, address indexed account, uint256 amount);
    event Redeemed(
        bytes32 indexed seriesId, address indexed account, uint256 yesAmount, uint256 noAmount, uint256 payout
    );

    error CollateralDecimalsMismatch(uint8 decimals);
    error ZeroAmount();
    error ZeroAddress();
    error MintClosed(bytes32 seriesId, uint64 closeTime);
    error NotResolved(bytes32 seriesId);
    error NotGuardian();

    constructor(address owner_, IIsothermResolver resolver_, IERC20 collateral_, address guardian_)
        StrikeFactory(owner_, resolver_)
    {
        uint8 dec = IERC20Metadata(address(collateral_)).decimals();
        if (dec != 6) revert CollateralDecimalsMismatch(dec);
        collateral = collateral_;
        guardian = guardian_;
        emit GuardianUpdated(address(0), guardian_);
    }

    // ---------------------------------------------------------------------------------------------
    // Minting (closes at series.closeTime; pausable)
    // ---------------------------------------------------------------------------------------------

    /// @notice Pull `amount` AUSD from the caller and mint `amount` YES + `amount` NO to the caller.
    function mintSet(bytes32 seriesId, uint256 amount) external {
        _mintSet(seriesId, amount, msg.sender, msg.sender);
    }

    /// @notice Same as mintSet but the tokens go to `to` (for zaps / routers).
    function mintSetTo(bytes32 seriesId, uint256 amount, address to) external {
        if (to == address(0)) revert ZeroAddress();
        _mintSet(seriesId, amount, msg.sender, to);
    }

    /// @notice Gasless mint for `holder` using an EIP-2612 AUSD permit (domain "Agora Dollar" v1). Anyone (a relayer)
    ///         may submit it; the AUSD always comes from `holder` and the tokens always go to `holder`.
    /// @dev The permit must succeed (no try/catch fallback to an existing allowance), so a third party can never
    ///      spend a holder's standing allowance on their behalf.
    function mintSetWithPermit(
        bytes32 seriesId,
        uint256 amount,
        address holder,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        IERC20Permit(address(collateral)).permit(holder, address(this), amount, deadline, v, r, s);
        _mintSet(seriesId, amount, holder, holder);
    }

    // ---------------------------------------------------------------------------------------------
    // Exits (never paused)
    // ---------------------------------------------------------------------------------------------

    /// @notice Burn `amount` YES + `amount` NO and get `amount` AUSD back. Works before and after resolution.
    function redeemSet(bytes32 seriesId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Series storage s = _getSeries(seriesId);
        s.yes.burn(msg.sender, amount);
        s.no.burn(msg.sender, amount);
        s.collateral -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit SetRedeemed(seriesId, msg.sender, amount);
    }

    /// @notice After the ladder is resolved, burn any mix of YES/NO and receive the payout.
    /// @return payout AUSD paid (6 decimals).
    function redeem(bytes32 seriesId, uint256 yesAmount, uint256 noAmount)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (yesAmount == 0 && noAmount == 0) revert ZeroAmount();
        Series storage s = _getSeries(seriesId);
        (uint256 yesHalves, uint256 noHalves) = _payoutHalves(seriesId, s);
        payout = (yesAmount * yesHalves + noAmount * noHalves) / 2;
        if (yesAmount != 0) s.yes.burn(msg.sender, yesAmount);
        if (noAmount != 0) s.no.burn(msg.sender, noAmount);
        s.collateral -= payout;
        if (payout != 0) collateral.safeTransfer(msg.sender, payout);
        emit Redeemed(seriesId, msg.sender, yesAmount, noAmount, payout);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Payout per token in half-AUSD units: (2,0) YES won, (0,2) NO won, (1,1) void. Reverts if unresolved.
    function payoutHalves(bytes32 seriesId) external view returns (uint256 yesHalves, uint256 noHalves) {
        return _payoutHalves(seriesId, _getSeries(seriesId));
    }

    function previewRedeem(bytes32 seriesId, uint256 yesAmount, uint256 noAmount) external view returns (uint256) {
        (uint256 yesHalves, uint256 noHalves) = _payoutHalves(seriesId, _getSeries(seriesId));
        return (yesAmount * yesHalves + noAmount * noHalves) / 2;
    }

    /// @notice Ladders in [start, start+count) whose local day has ended and that have no result yet
    ///         (what the CRE settlement workflow should report on).
    function duePendingLadders(uint256 start, uint256 count) external view returns (LadderRef[] memory due) {
        uint256 end = _ladders.length;
        if (start >= end) return due;
        if (count < end - start) end = start + count;
        due = new LadderRef[](end - start);
        uint256 n;
        for (uint256 i = start; i < end; ++i) {
            LadderRef memory l = _ladders[i];
            if (
                block.timestamp >= resolver.dayEnd(l.station, l.date)
                    && resolver.resultOf(l.station, l.date).status == IIsothermResolver.Status.None
            ) {
                due[n++] = l;
            }
        }
        assembly ("memory-safe") {
            mstore(due, n)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function setGuardian(address guardian_) external onlyOwner {
        emit GuardianUpdated(guardian, guardian_);
        guardian = guardian_;
    }

    /// @notice Stop new minting. Guardian or owner.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _mintSet(bytes32 seriesId, uint256 amount, address payer, address to) internal nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        Series storage s = _getSeries(seriesId);
        if (block.timestamp >= s.closeTime) revert MintClosed(seriesId, s.closeTime);
        s.collateral += amount;
        collateral.safeTransferFrom(payer, address(this), amount);
        s.yes.mint(to, amount);
        s.no.mint(to, amount);
        emit SetMinted(seriesId, payer, to, amount);
    }

    function _payoutHalves(bytes32 seriesId, Series storage s)
        internal
        view
        returns (uint256 yesHalves, uint256 noHalves)
    {
        IIsothermResolver.Result memory r = resolver.resultOf(s.station, s.date);
        if (r.status == IIsothermResolver.Status.Settled) return r.tmaxC >= s.strikeC ? (2, 0) : (0, 2);
        if (r.status == IIsothermResolver.Status.Void) return (1, 1);
        revert NotResolved(seriesId);
    }
}
