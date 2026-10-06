// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Resolver} from "../src/Resolver.sol";
import {CollateralVault} from "../src/CollateralVault.sol";

/// @notice Deploys the Isotherm testnet core (Resolver + CollateralVault/StrikeFactory) and registers stations.
///
/// Env (all optional except ATTESTER):
///   ATTESTER   address that signs settlement attestations (required; use a dedicated key, not the deployer)
///   FORWARDER  CRE forwarder. Default: MockKeystoneForwarder on 10143 (for `cre workflow simulate --broadcast`).
///              Production KeystoneForwarder on 10143: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
///   AUSD       collateral token. Default: testnet AUSD 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
///   GUARDIAN   pause key. Default: deployer
///   OPERATOR   extra series-creation key (e.g. the daily roll job). Default: none (owner can always create)
///   NEW_OWNER  if set, starts a 2-step ownership transfer of both contracts (NEW_OWNER must acceptOwnership()).
///
/// Testnet:  forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $DEPLOYER_KEY \
///             --gas-estimate-multiplier 110 --slow
contract Deploy is Script {
    address internal constant MOCK_FORWARDER_10143 = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
    address internal constant AUSD_10143 = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;

    function run() external returns (Resolver resolver, CollateralVault vault) {
        require(block.chainid != 143, "Deploy: testnet stack only (use DeployForecastCommit for mainnet)");
        address attester = vm.envAddress("ATTESTER");
        address forwarder = vm.envOr("FORWARDER", MOCK_FORWARDER_10143);
        address ausd = vm.envOr("AUSD", AUSD_10143);
        address operator = vm.envOr("OPERATOR", address(0));
        address newOwner = vm.envOr("NEW_OWNER", address(0));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address guardian = vm.envOr("GUARDIAN", deployer);

        resolver = new Resolver(deployer, forwarder, attester, guardian);
        vault = new CollateralVault(deployer, resolver, IERC20(ausd), guardian);

        // ICAO stations Polymarket resolves Asian city highs on (UTC offsets are write-once).
        resolver.registerStation("RCSS", 8 hours); // Taipei Songshan
        resolver.registerStation("RJTT", 9 hours); // Tokyo Haneda
        resolver.registerStation("ZGSZ", 8 hours); // Shenzhen Bao'an
        resolver.registerStation("RKSI", 9 hours); // Seoul Incheon

        if (operator != address(0)) vault.setOperator(operator, true);
        if (newOwner != address(0)) {
            resolver.transferOwnership(newOwner);
            vault.transferOwnership(newOwner);
        }
        vm.stopBroadcast();

        console2.log("chainId          ", block.chainid);
        console2.log("Resolver         ", address(resolver));
        console2.log("CollateralVault  ", address(vault));
        console2.log("OutcomeToken impl", vault.tokenImplementation());
        console2.log("forwarder        ", forwarder);
        console2.log("attester         ", attester);
        console2.log("guardian         ", guardian);
        console2.log("collateral       ", ausd);
    }
}
