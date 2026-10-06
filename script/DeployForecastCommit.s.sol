// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ForecastCommit} from "../src/ForecastCommit.sol";

/// @notice Deploys ForecastCommit (intended for Monad MAINNET 143, where the calibration record lives) and registers
///         stations. A human runs the mainnet broadcast; dry-run first without --broadcast:
///   forge script script/DeployForecastCommit.s.sol --rpc-url monad --sender <addr>            # simulation only
///   forge script script/DeployForecastCommit.s.sol --rpc-url monad --broadcast --private-key $KEY --verify ...
contract DeployForecastCommit is Script {
    function run() external returns (ForecastCommit fc) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        fc = new ForecastCommit(vm.envOr("OWNER", deployer));
        if (fc.owner() == deployer) {
            fc.registerStation("RCSS", 8 hours);
            fc.registerStation("RJTT", 9 hours);
            fc.registerStation("ZGSZ", 8 hours);
            fc.registerStation("RKSI", 9 hours);
        }
        vm.stopBroadcast();
        console2.log("chainId       ", block.chainid);
        console2.log("ForecastCommit", address(fc));
    }
}
