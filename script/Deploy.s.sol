// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Resolver} from "../src/Resolver.sol";
import {CollateralVault} from "../src/CollateralVault.sol";
import {IsothermZap} from "../src/IsothermZap.sol";
import {IKuruRouterView} from "../src/interfaces/IKuru.sol";

/// @notice Deploys the Isotherm v1 testnet core: Resolver + CollateralVault (StrikeFactory + OutcomeToken impl) +
///         IsothermZap, registers RCSS (Taipei, UTC+8) and RJTT (Tokyo, UTC+9) and sets the operator.
///         The broadcaster becomes the owner of everything. Creates no ladders and no markets.
///
/// Env:
///   ATTESTER          address that signs settlement attestations (required; dedicated key, not the deployer)
///   GUARDIAN          pause + challenge key (required; dedicated key)
///   OPERATOR          series-creation / canonical-market key for the daily roll job (required)
///   CHALLENGE_WINDOW  seconds a Settled result waits before redemption (default 900 = 15 min; max 2 days)
///   FORWARDER         CRE forwarder. Default: MockKeystoneForwarder on 10143 (`cre workflow simulate --broadcast`).
///                     Production KeystoneForwarder on 10143: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
///   AUSD              collateral token. Default: testnet AUSD 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
///   KURU_ROUTER       Kuru v1 Router. Default: 0x7EFbE105Ca7415dE98F96622173458ac1c054630
///
/// Use script/deploy-testnet.sh (estimates, broadcasts with a 1.08 gas multiplier and writes deployments/testnet.json).
contract Deploy is Script {
    address internal constant MOCK_FORWARDER_10143 = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
    address internal constant AUSD_10143 = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant KURU_ROUTER_10143 = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;

    function run() external returns (Resolver resolver, CollateralVault vault, IsothermZap zap) {
        require(block.chainid != 143, "Deploy: testnet stack only (use DeployForecastCommit for mainnet)");
        address attester = vm.envAddress("ATTESTER");
        address guardian = vm.envAddress("GUARDIAN");
        address operator = vm.envAddress("OPERATOR");
        uint256 challengeWindow = vm.envOr("CHALLENGE_WINDOW", uint256(15 minutes));
        address forwarder = vm.envOr("FORWARDER", MOCK_FORWARDER_10143);
        address ausd = vm.envOr("AUSD", AUSD_10143);
        address router = vm.envOr("KURU_ROUTER", KURU_ROUTER_10143);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(attester != deployer && guardian != deployer && operator != deployer, "Deploy: roles must be separate");

        resolver = new Resolver(deployer, forwarder, attester, guardian, challengeWindow);
        vault = new CollateralVault(deployer, resolver, IERC20(ausd), guardian);
        zap = new IsothermZap(IKuruRouterView(router), vault);

        // ICAO stations Polymarket resolves Asian city highs on (UTC offsets are write-once).
        resolver.registerStation("RCSS", 8 hours); // Taipei Songshan
        resolver.registerStation("RJTT", 9 hours); // Tokyo Haneda
        vault.setOperator(operator, true);
        vm.stopBroadcast();

        console2.log("chainId          ", block.chainid);
        console2.log("Resolver         ", address(resolver));
        console2.log("CollateralVault  ", address(vault));
        console2.log("IsothermZap      ", address(zap));
        console2.log("OutcomeToken impl", vault.tokenImplementation());
        console2.log("owner            ", deployer);
        console2.log("forwarder        ", forwarder);
        console2.log("attester         ", attester);
        console2.log("guardian         ", guardian);
        console2.log("operator         ", operator);
        console2.log("challengeWindow  ", challengeWindow);
        console2.log("collateral       ", ausd);
    }
}
