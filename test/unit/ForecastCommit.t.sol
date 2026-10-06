// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ForecastCommit} from "../../src/ForecastCommit.sol";
import {StationTime} from "../../src/lib/StationTime.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ForecastCommitTest is Test {
    ForecastCommit fc;
    address owner = makeAddr("owner");
    address maker = makeAddr("maker");
    address rival = makeAddr("rival");
    bytes4 constant RCSS = "RCSS";
    uint32 constant D = 20261007;
    // Taipei 2026-10-07 starts at 2026-10-06T16:00:00Z
    uint256 constant DEADLINE = 1_791_244_800 + 16 hours;
    bytes32 constant SALT = keccak256("salt");

    event ForecastRevealed(
        address indexed forecaster,
        bytes4 indexed station,
        uint32 indexed date,
        int16[] strikesC,
        uint16[] probBps,
        bytes32 salt,
        uint64 committedAt
    );

    function setUp() public {
        fc = new ForecastCommit(owner);
        vm.prank(owner);
        fc.registerStation(RCSS, 8 hours);
        vm.warp(DEADLINE - 1 hours); // 23:00 Taipei the evening before
    }

    function _ladder() internal pure returns (int16[] memory ks, uint16[] memory ps) {
        ks = new int16[](4);
        ps = new uint16[](4);
        (ks[0], ks[1], ks[2], ks[3]) = (28, 29, 30, 31);
        (ps[0], ps[1], ps[2], ps[3]) = (9500, 7200, 4100, 1300);
    }

    function test_commitReveal() public {
        (int16[] memory ks, uint16[] memory ps) = _ladder();
        bytes32 h = fc.forecastHash(maker, RCSS, D, ks, ps, SALT);
        assertEq(h, keccak256(abi.encode(maker, RCSS, D, ks, ps, SALT)));
        vm.prank(maker);
        fc.commit(RCSS, D, h);
        ForecastCommit.Commitment memory c = fc.commitmentOf(maker, RCSS, D);
        assertEq(c.hash, h);
        assertEq(c.committedAt, DEADLINE - 1 hours);

        vm.warp(DEADLINE + 1 days); // reveal after the day
        vm.expectEmit(address(fc));
        emit ForecastRevealed(maker, RCSS, D, ks, ps, SALT, uint64(DEADLINE - 1 hours));
        vm.prank(maker);
        fc.reveal(RCSS, D, ks, ps, SALT);
        assertEq(fc.commitmentOf(maker, RCSS, D).revealedAt, DEADLINE + 1 days);

        vm.prank(maker);
        vm.expectRevert(ForecastCommit.AlreadyRevealed.selector);
        fc.reveal(RCSS, D, ks, ps, SALT);
    }

    function test_commitDeadline() public {
        assertEq(fc.commitDeadline(RCSS, D), DEADLINE);
        vm.warp(DEADLINE);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(ForecastCommit.CommitWindowClosed.selector, DEADLINE));
        fc.commit(RCSS, D, keccak256("x"));
    }

    function test_cannotOverwrite() public {
        vm.startPrank(maker);
        fc.commit(RCSS, D, keccak256("a"));
        vm.expectRevert(ForecastCommit.AlreadyCommitted.selector);
        fc.commit(RCSS, D, keccak256("b"));
        vm.stopPrank();
        assertEq(fc.commitmentOf(maker, RCSS, D).hash, keccak256("a"));
    }

    function test_forecastersAreIndependent() public {
        (int16[] memory ks, uint16[] memory ps) = _ladder();
        bytes32 h = fc.forecastHash(maker, RCSS, D, ks, ps, SALT);
        vm.prank(maker);
        fc.commit(RCSS, D, h);
        // a copier who commits the same hash cannot reveal it: the hash binds the forecaster address
        vm.prank(rival);
        fc.commit(RCSS, D, h);
        vm.prank(rival);
        vm.expectRevert(ForecastCommit.HashMismatch.selector);
        fc.reveal(RCSS, D, ks, ps, SALT);
    }

    function test_revealValidation() public {
        vm.prank(maker);
        vm.expectRevert(ForecastCommit.NoCommit.selector);
        fc.reveal(RCSS, D, new int16[](1), new uint16[](1), SALT);

        int16[] memory ks = new int16[](2);
        uint16[] memory ps = new uint16[](2);
        (ks[0], ks[1]) = (30, 30); // not strictly increasing
        (ps[0], ps[1]) = (5000, 4000);
        vm.startPrank(maker);
        fc.commit(RCSS, D, fc.forecastHash(maker, RCSS, D, ks, ps, SALT));
        vm.expectRevert(ForecastCommit.BadForecast.selector);
        fc.reveal(RCSS, D, ks, ps, SALT);
        vm.expectRevert(ForecastCommit.HashMismatch.selector);
        fc.reveal(RCSS, D, ks, ps, bytes32(0));
        vm.stopPrank();

        (ks[0], ks[1]) = (30, 31);
        (ps[0], ps[1]) = (10_001, 4000); // > 100%
        vm.startPrank(rival);
        fc.commit(RCSS, D, fc.forecastHash(rival, RCSS, D, ks, ps, SALT));
        vm.expectRevert(ForecastCommit.BadForecast.selector);
        fc.reveal(RCSS, D, ks, ps, SALT);
        vm.stopPrank();
    }

    function test_misc() public {
        vm.expectRevert(ForecastCommit.EmptyHash.selector);
        fc.commit(RCSS, D, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ForecastCommit.UnknownStation.selector, bytes4("RJTT")));
        fc.commit("RJTT", D, keccak256("x"));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ForecastCommit.StationAlreadyRegistered.selector, RCSS));
        fc.registerStation(RCSS, 9 hours);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, maker));
        fc.registerStation("RJTT", 9 hours);
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidDate.selector, uint32(20261399)));
        fc.commit(RCSS, 20261399, keccak256("x"));
    }

    function testFuzz_commitReveal(int16 k0, uint16 p0, bytes32 salt) public {
        p0 = uint16(bound(p0, 0, 10_000));
        int16[] memory ks = new int16[](1);
        uint16[] memory ps = new uint16[](1);
        ks[0] = k0;
        ps[0] = p0;
        vm.startPrank(maker);
        fc.commit(RCSS, D, fc.forecastHash(maker, RCSS, D, ks, ps, salt));
        fc.reveal(RCSS, D, ks, ps, salt);
        vm.stopPrank();
        assertGt(fc.commitmentOf(maker, RCSS, D).revealedAt, 0);
    }
}
