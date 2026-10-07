// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {OutcomeToken} from "./OutcomeToken.sol";
import {IIsothermResolver} from "./interfaces/IIsothermResolver.sol";

/// @title StrikeFactory (series registry)
/// @notice A series is one "Tmax >= strikeC" contract for a (station, local date). Series sharing a (station, date)
///         form a ladder and are all settled by the single Resolver result for that city-date.
///         Each series gets a YES and a NO OutcomeToken, deployed as CREATE2 clones (deterministic addresses).
/// @dev Abstract: CollateralVault inherits it so the registry and the collateral live at one address and the vault
///      is the tokens' sole minter without any deployment-order cycle.
abstract contract StrikeFactory is Ownable2Step {
    struct Series {
        // slot 0
        bytes4 station; // ICAO code, e.g. "RCSS" (Taipei Songshan)
        uint32 date; // station-local date, yyyymmdd
        int16 strikeC; // YES wins iff official daily max (integer degC) >= strikeC
        uint64 closeTime; // minting closes at this UTC timestamp (<= end of the local day)
        bool gated; // compliance flag: if set, only allowlisted recipients may mint (CollateralVault.setSeriesGated)
        // slot 1, 2
        OutcomeToken yes;
        OutcomeToken no;
        // slot 3: AUSD currently backing this series (maintained by CollateralVault)
        uint256 collateral;
    }

    struct LadderRef {
        bytes4 station;
        uint32 date;
    }

    int16 public constant MIN_STRIKE_C = -90;
    int16 public constant MAX_STRIKE_C = 70;

    IIsothermResolver public immutable resolver;
    /// @notice OutcomeToken implementation that every YES/NO clone delegates to.
    address public immutable tokenImplementation;

    mapping(address account => bool) public isOperator;
    mapping(bytes32 seriesId => Series) internal _series;
    mapping(bytes4 station => mapping(uint32 date => bytes32[])) internal _ladderSeries;
    LadderRef[] internal _ladders;

    event OperatorUpdated(address indexed account, bool enabled);
    event LadderCreated(bytes4 indexed station, uint32 indexed date, uint256 index);
    event SeriesCreated(
        bytes32 indexed seriesId,
        bytes4 indexed station,
        uint32 indexed date,
        int16 strikeC,
        uint64 closeTime,
        address yes,
        address no
    );

    error NotOperator();
    error SeriesExists(bytes32 seriesId);
    error UnknownSeries(bytes32 seriesId);
    error StrikeOutOfRange(int16 strikeC);
    error BadCloseTime(uint64 closeTime, uint256 dayEnd);
    error EmptyLadder();

    constructor(address owner_, IIsothermResolver resolver_) Ownable(owner_) {
        resolver = resolver_;
        tokenImplementation = address(new OutcomeToken(address(this)));
    }

    modifier onlyOperator() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Series creation (operator)
    // ---------------------------------------------------------------------------------------------

    function createSeries(bytes4 station, uint32 date, int16 strikeC, uint64 closeTime)
        external
        onlyOperator
        returns (bytes32 seriesId)
    {
        _checkCloseTime(station, date, closeTime);
        return _createSeries(station, date, strikeC, closeTime);
    }

    /// @notice Create several strikes of one city-date in one transaction (all share `closeTime`).
    function createLadder(bytes4 station, uint32 date, int16[] calldata strikesC, uint64 closeTime)
        external
        onlyOperator
        returns (bytes32[] memory seriesIds)
    {
        if (strikesC.length == 0) revert EmptyLadder();
        _checkCloseTime(station, date, closeTime);
        seriesIds = new bytes32[](strikesC.length);
        for (uint256 i; i < strikesC.length; ++i) {
            seriesIds[i] = _createSeries(station, date, strikesC[i], closeTime);
        }
    }

    function setOperator(address account, bool enabled) external onlyOwner {
        isOperator[account] = enabled;
        emit OperatorUpdated(account, enabled);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function seriesIdOf(bytes4 station, uint32 date, int16 strikeC) public pure returns (bytes32) {
        return keccak256(abi.encode(station, date, strikeC));
    }

    function getSeries(bytes32 seriesId) external view returns (Series memory) {
        return _series[seriesId];
    }

    function ladderSeries(bytes4 station, uint32 date) external view returns (bytes32[] memory) {
        return _ladderSeries[station][date];
    }

    function ladderCount() external view returns (uint256) {
        return _ladders.length;
    }

    function ladderAt(uint256 index) external view returns (LadderRef memory) {
        return _ladders[index];
    }

    /// @notice Deterministic address of a series' YES (isYes = true) or NO token, before or after creation.
    function predictTokenAddress(bytes4 station, uint32 date, int16 strikeC, bool isYes)
        external
        view
        returns (address)
    {
        bytes32 seriesId = seriesIdOf(station, date, strikeC);
        return Clones.predictDeterministicAddressWithImmutableArgs(
            tokenImplementation, _tokenArgs(seriesId, station, date, strikeC, isYes), _tokenSalt(seriesId, isYes)
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _getSeries(bytes32 seriesId) internal view returns (Series storage s) {
        s = _series[seriesId];
        if (address(s.yes) == address(0)) revert UnknownSeries(seriesId);
    }

    function _checkCloseTime(bytes4 station, uint32 date, uint64 closeTime) internal view {
        uint256 end = resolver.dayEnd(station, date); // reverts for unknown station / invalid date
        if (closeTime <= block.timestamp || closeTime > end) revert BadCloseTime(closeTime, end);
    }

    function _createSeries(bytes4 station, uint32 date, int16 strikeC, uint64 closeTime)
        internal
        returns (bytes32 seriesId)
    {
        if (strikeC < MIN_STRIKE_C || strikeC > MAX_STRIKE_C) revert StrikeOutOfRange(strikeC);
        seriesId = seriesIdOf(station, date, strikeC);
        Series storage s = _series[seriesId];
        if (address(s.yes) != address(0)) revert SeriesExists(seriesId);

        OutcomeToken yes = OutcomeToken(
            Clones.cloneDeterministicWithImmutableArgs(
                tokenImplementation, _tokenArgs(seriesId, station, date, strikeC, true), _tokenSalt(seriesId, true)
            )
        );
        OutcomeToken no = OutcomeToken(
            Clones.cloneDeterministicWithImmutableArgs(
                tokenImplementation, _tokenArgs(seriesId, station, date, strikeC, false), _tokenSalt(seriesId, false)
            )
        );

        s.station = station;
        s.date = date;
        s.strikeC = strikeC;
        s.closeTime = closeTime;
        s.yes = yes;
        s.no = no;

        bytes32[] storage ladder = _ladderSeries[station][date];
        if (ladder.length == 0) {
            _ladders.push(LadderRef({station: station, date: date}));
            emit LadderCreated(station, date, _ladders.length - 1);
        }
        ladder.push(seriesId);

        emit SeriesCreated(seriesId, station, date, strikeC, closeTime, address(yes), address(no));
    }

    function _tokenArgs(bytes32 seriesId, bytes4 station, uint32 date, int16 strikeC, bool isYes)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(seriesId, station, date, strikeC, isYes);
    }

    function _tokenSalt(bytes32 seriesId, bool isYes) internal pure returns (bytes32) {
        return keccak256(abi.encode(seriesId, isYes));
    }
}
