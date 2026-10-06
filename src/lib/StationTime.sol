// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title StationTime
/// @notice Pure helpers that turn (station code, local calendar date) into UTC timestamps.
/// @dev Dates are `uint32` in yyyymmdd form (e.g. 20261007). A station's local day `date` spans
///      [dayStartUtc(date) - utcOffset, dayStartUtc(date) - utcOffset + 1 days).
///      Station codes are 4-character ICAO identifiers ([A-Z0-9]{4}, e.g. "RCSS"), packed as bytes4.
library StationTime {
    error InvalidDate(uint32 date);
    error InvalidStationCode(bytes4 station);
    error InvalidUtcOffset(int32 utcOffsetSeconds);

    uint256 internal constant MIN_YEAR = 2000;
    uint256 internal constant MAX_YEAR = 2199;
    /// @dev Real-world offsets range from UTC-12:00 to UTC+14:00, all multiples of 15 minutes.
    int32 internal constant MIN_OFFSET = -12 hours;
    int32 internal constant MAX_OFFSET = 14 hours;

    /// @notice UTC timestamp of 00:00:00 UTC on the calendar date `date` (yyyymmdd). Reverts if invalid.
    function dayStartUtc(uint32 date) internal pure returns (uint256) {
        uint256 y = date / 10_000;
        uint256 m = (date / 100) % 100;
        uint256 d = date % 100;
        if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
            revert InvalidDate(date);
        }
        return daysFromCivil(y, m, d) * 1 days;
    }

    /// @notice First second of the station-local day `date`, as a UTC timestamp.
    function localDayStart(uint32 date, int32 utcOffsetSeconds) internal pure returns (uint256) {
        // dayStartUtc >= 946,684,800 (year 2000) and |offset| <= 14h, so this never underflows.
        return uint256(int256(dayStartUtc(date)) - int256(utcOffsetSeconds));
    }

    /// @notice First second AFTER the station-local day `date` (i.e. local midnight that ends it), UTC.
    function localDayEnd(uint32 date, int32 utcOffsetSeconds) internal pure returns (uint256) {
        return localDayStart(date, utcOffsetSeconds) + 1 days;
    }

    function daysInMonth(uint256 y, uint256 m) internal pure returns (uint256) {
        if (m == 2) return isLeapYear(y) ? 29 : 28;
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return 31;
    }

    function isLeapYear(uint256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    /// @dev Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's days_from_civil),
    ///      restricted to y >= 2000 so all intermediate values stay non-negative.
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400; // [0, 399]
        uint256 mp = m > 2 ? m - 3 : m + 9; // March = 0
        uint256 doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
        return era * 146_097 + doe - 719_468;
    }

    /// @notice Reverts unless `station` is exactly four characters from [A-Z0-9].
    function validateStation(bytes4 station) internal pure {
        for (uint256 i; i < 4; ++i) {
            bytes1 c = station[i];
            bool ok = (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39);
            if (!ok) revert InvalidStationCode(station);
        }
    }

    /// @notice Reverts unless the offset is within [-12h, +14h] and a multiple of 15 minutes.
    function validateOffset(int32 utcOffsetSeconds) internal pure {
        if (utcOffsetSeconds < MIN_OFFSET || utcOffsetSeconds > MAX_OFFSET || utcOffsetSeconds % 900 != 0) {
            revert InvalidUtcOffset(utcOffsetSeconds);
        }
    }
}
