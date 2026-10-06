// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Resolver} from "isotherm/Resolver.sol";

/// Deploys the builder's Resolver wired to the CRE MockKeystoneForwarder and registers RCSS (UTC+8).
/// Keys come from env vars (never argv):
///   ISOTHERM_DEPLOYER_KEY  owner/guardian/deployer (hex)
///   ISOTHERM_ATTESTER_ADDR attester address whose key signs settlements inside the workflow
/// anvil fork:  forge script script/DeploySpikeResolver.s.sol --rpc-url http://127.0.0.1:18845 --broadcast
contract DeploySpikeResolver is Script {
    address constant MOCK_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;

    function run() external returns (Resolver r) {
        uint256 pk = vm.envUint("ISOTHERM_DEPLOYER_KEY");
        address attester = vm.envAddress("ISOTHERM_ATTESTER_ADDR");
        address owner = vm.addr(pk);
        vm.startBroadcast(pk);
        r = new Resolver(owner, MOCK_FORWARDER, attester, owner);
        r.registerStation("RCSS", 8 hours);
        vm.stopBroadcast();
        console2.log("Resolver", address(r));
    }
}
