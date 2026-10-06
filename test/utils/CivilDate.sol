// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Independent inverse of StationTime.daysFromCivil (H. Hinnant's civil_from_days), used to cross-check the
///      production date math and to derive "tomorrow in Taipei" from a fork's block.timestamp.
library CivilDate {
    function fromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    function yyyymmdd(uint256 dayNumber) internal pure returns (uint32) {
        (uint256 y, uint256 m, uint256 d) = fromDays(dayNumber);
        return uint32(y * 10_000 + m * 100 + d);
    }

    /// @dev Station-local calendar date containing UTC timestamp `ts`.
    function localDate(uint256 ts, int32 utcOffset) internal pure returns (uint32) {
        return yyyymmdd(uint256(int256(ts) + int256(utcOffset)) / 1 days);
    }
}
