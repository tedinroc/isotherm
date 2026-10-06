// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StationTime} from "../../src/lib/StationTime.sol";
import {CivilDate} from "../utils/CivilDate.sol";

contract StationTimeHarness {
    function dayStartUtc(uint32 date) external pure returns (uint256) {
        return StationTime.dayStartUtc(date);
    }

    function localDayEnd(uint32 date, int32 off) external pure returns (uint256) {
        return StationTime.localDayEnd(date, off);
    }

    function validateStation(bytes4 s) external pure {
        StationTime.validateStation(s);
    }

    function validateOffset(int32 o) external pure {
        StationTime.validateOffset(o);
    }
}

contract StationTimeTest is Test {
    StationTimeHarness h = new StationTimeHarness();

    function test_knownVectors() public view {
        // python3: datetime.fromisoformat('YYYY-MM-DDT00:00:00+00:00').timestamp()
        assertEq(h.dayStartUtc(20000101), 946_684_800);
        assertEq(h.dayStartUtc(20261006), 1_791_244_800);
        assertEq(h.dayStartUtc(20261007), 1_791_331_200);
        assertEq(h.dayStartUtc(20240229), 1_709_164_800);
        assertEq(h.dayStartUtc(21991231), 7_258_032_000);
    }

    function test_taipeiDayEnd() public view {
        // Taipei 2026-10-07 ends at 2026-10-08T00:00+08:00 == 2026-10-07T16:00Z
        assertEq(h.localDayEnd(20261007, 8 hours), 1_791_331_200 + 16 hours);
        // A UTC-5 station's 2026-10-07 ends at 2026-10-08T05:00Z
        assertEq(h.localDayEnd(20261007, -5 hours), 1_791_331_200 + 29 hours);
    }

    function test_invalidDates() public {
        uint32[9] memory bad =
            [uint32(20250229), 20261332, 20000230, 19991231, 22000101, 20261000, 20260100, 20260431, 0];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidDate.selector, bad[i]));
            h.dayStartUtc(bad[i]);
        }
        assertEq(h.dayStartUtc(20000229), 951_782_400); // 2000 is a leap year (divisible by 400)
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidDate.selector, uint32(21000229)));
        h.dayStartUtc(21000229); // 2100 is not
    }

    /// @dev Two independent algorithms (days_from_civil vs civil_from_days) must agree on every day 2000..2199.
    function testFuzz_roundTrip(uint256 dayNumber) public view {
        dayNumber = bound(dayNumber, 10_957, 84_005); // 2000-01-01 .. 2199-12-31
        uint32 date = CivilDate.yyyymmdd(dayNumber);
        assertEq(h.dayStartUtc(date), dayNumber * 1 days);
    }

    function testFuzz_consecutiveDays(uint256 dayNumber) public view {
        dayNumber = bound(dayNumber, 10_957, 84_004);
        uint32 a = CivilDate.yyyymmdd(dayNumber);
        uint32 b = CivilDate.yyyymmdd(dayNumber + 1);
        assertEq(h.dayStartUtc(b) - h.dayStartUtc(a), 1 days);
    }

    function test_validateStation() public {
        h.validateStation("RCSS");
        h.validateStation("ZGSZ");
        h.validateStation("K0A9");
        bytes4[4] memory bad = [bytes4("rcss"), bytes4("RCS"), bytes4("RC-S"), bytes4(0)];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidStationCode.selector, bad[i]));
            h.validateStation(bad[i]);
        }
    }

    function test_validateOffset() public {
        h.validateOffset(8 hours);
        h.validateOffset(-12 hours);
        h.validateOffset(14 hours);
        h.validateOffset(20_700); // Nepal +05:45
        int32[4] memory bad = [int32(8 hours + 1), 14 hours + 900, -12 hours - 900, 1];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidUtcOffset.selector, bad[i]));
            h.validateOffset(bad[i]);
        }
    }
}
