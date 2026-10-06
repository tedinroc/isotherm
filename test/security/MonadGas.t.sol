// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IsoTest} from "../utils/IsoTest.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {CivilDate} from "../utils/CivilDate.sol";

/// @notice Cold-storage cost of the view the CRE workflow polls (Monad: cold SLOAD 8,115, cold account 10,115).
///         `forge test` runs with network = "monad", so these are Monad-schedule numbers.
contract MonadGasTest is IsoTest {
    function test_gas_duePendingLaddersPerLadderCold() public {
        uint256 n = 40;
        for (uint256 i; i < n; ++i) {
            uint32 d = CivilDate.yyyymmdd(T0 / 1 days + 1 + i);
            uint64 close = uint64(resolver.dayEnd(RCSS, d) - 1 hours);
            vm.prank(operator);
            vault.createSeries(RCSS, d, 30, close);
        }
        vm.warp(T0 + (n + 3) * 1 days); // every ladder due
        vm.cool(address(vault));
        vm.cool(address(resolver));
        uint256 g = gasleft();
        StrikeFactory.LadderRef[] memory one = vault.duePendingLadders(0, 1);
        uint256 g1 = g - gasleft();
        vm.cool(address(vault));
        vm.cool(address(resolver));
        g = gasleft();
        StrikeFactory.LadderRef[] memory all = vault.duePendingLadders(0, n);
        uint256 gn = g - gasleft();
        assertEq(one.length, 1);
        assertEq(all.length, n);
        uint256 perLadder = (gn - g1) / (n - 1);
        console2.log("duePendingLadders(0,1) cold gas", g1);
        console2.log("duePendingLadders(0,40) cold gas", gn);
        console2.log("marginal gas per ladder", perLadder);
        console2.log("ladders per 30M-gas eth_call", (30_000_000 - g1) / perLadder);
    }
}
