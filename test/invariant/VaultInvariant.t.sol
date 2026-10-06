// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {MockAUSD} from "../utils/MockAUSD.sol";

/// @dev Drives the vault through random mints, set redemptions, transfers, settlements, stale voids, redemptions
///      and time jumps. Every action is bounded to be valid, so `fail_on_revert = true` also proves no valid user
///      action ever reverts unexpectedly.
contract VaultHandler is Test {
    struct LadderKey {
        bytes4 station;
        uint32 date;
    }

    CollateralVault public vault;
    Resolver public resolver;
    MockAUSD public ausd;
    uint256 internal attesterPk;
    address internal forwarder;

    address[] public actors;
    bytes32[] public seriesIds;
    LadderKey[] public ladders;

    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    mapping(bytes32 => uint256) public ghostMinted;
    mapping(bytes32 => uint256) public ghostPaid;
    uint256 public fullSetMismatches;
    uint256 public payoutMismatches;
    mapping(bytes32 => bytes32) public resolvedSnapshot; // keccak(station,date) => keccak(result)

    mapping(string => uint256) public calls;

    constructor(
        CollateralVault vault_,
        Resolver resolver_,
        MockAUSD ausd_,
        uint256 attesterPk_,
        address forwarder_,
        bytes32[] memory ids,
        LadderKey[] memory ladders_
    ) {
        vault = vault_;
        resolver = resolver_;
        ausd = ausd_;
        attesterPk = attesterPk_;
        forwarder = forwarder_;
        seriesIds = ids;
        for (uint256 i; i < ladders_.length; ++i) {
            ladders.push(ladders_[i]);
        }
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            vm.prank(a);
            ausd.approve(address(vault), type(uint256).max);
        }
    }

    // --- actions -----------------------------------------------------------------------------------

    function mintSet(uint256 actorSeed, uint256 seriesSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        bytes32 id = seriesIds[seriesSeed % seriesIds.length];
        if (block.timestamp >= vault.getSeries(id).closeTime) return;
        amount = bound(amount, 1, 1e13);
        ausd.mint(actor, amount);
        vm.prank(actor);
        vault.mintSet(id, amount);
        ghostDeposited += amount;
        ghostMinted[id] += amount;
        calls["mintSet"]++;
    }

    function redeemSet(uint256 actorSeed, uint256 seriesSeed, uint256 amount) external {
        bytes32 id = seriesIds[seriesSeed % seriesIds.length];
        StrikeFactory.Series memory s = vault.getSeries(id);
        address actor = _holder(s, actorSeed, true);
        uint256 maxAmt = _min(s.yes.balanceOf(actor), s.no.balanceOf(actor));
        if (maxAmt == 0) return;
        amount = bound(amount, 1, maxAmt);
        uint256 before = ausd.balanceOf(actor);
        vm.prank(actor);
        vault.redeemSet(id, amount);
        if (ausd.balanceOf(actor) - before != amount) fullSetMismatches++;
        ghostPaidOut += amount;
        ghostPaid[id] += amount;
        calls["redeemSet"]++;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 seriesSeed, bool isYes, uint256 amount) external {
        StrikeFactory.Series memory s = vault.getSeries(seriesIds[seriesSeed % seriesIds.length]);
        OutcomeToken t = isYes ? s.yes : s.no;
        address from = _holder(s, fromSeed, false);
        address to = actors[toSeed % actors.length];
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        t.transfer(to, amount);
        calls["transfer"]++;
    }

    /// @dev Only 1 in 16 calls may jump the clock forward to the end of the day; otherwise time advances through
    ///      `warp`, so runs interleave minting/trading with settlement instead of resolving everything at once.
    function settle(uint256 ladderSeed, int16 tmax, bool isVoid, uint8 jump) external {
        LadderKey memory l = ladders[ladderSeed % ladders.length];
        if (resolver.resultOf(l.station, l.date).status != IIsothermResolver.Status.None) return;
        uint256 end = resolver.dayEnd(l.station, l.date);
        if (block.timestamp < end) {
            if (jump % 16 != 0) return;
            vm.warp(end);
        }
        tmax = int16(bound(tmax, -90, 70));
        bytes32 src = keccak256(abi.encode(l.station, l.date, tmax));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attesterPk, resolver.settlementDigest(l.station, l.date, tmax, isVoid, src));
        bytes memory report = abi.encode(l.station, l.date, tmax, isVoid, src, abi.encodePacked(r, s, v));
        vm.prank(forwarder);
        resolver.onReport(new bytes(64), report);
        _snapshot(l);
        calls["settle"]++;
    }

    function voidStale(uint256 ladderSeed, uint8 jump) external {
        LadderKey memory l = ladders[ladderSeed % ladders.length];
        if (resolver.resultOf(l.station, l.date).status != IIsothermResolver.Status.None) return;
        uint256 staleAt = resolver.dayEnd(l.station, l.date) + resolver.STALE_WINDOW();
        if (block.timestamp < staleAt) {
            if (jump % 16 != 0) return;
            vm.warp(staleAt);
        }
        resolver.voidIfStale(l.station, l.date);
        _snapshot(l);
        calls["voidStale"]++;
    }

    function redeem(uint256 actorSeed, uint256 seriesSeed, uint256 yesAmt, uint256 noAmt) external {
        bytes32 id = seriesIds[seriesSeed % seriesIds.length];
        StrikeFactory.Series memory s = vault.getSeries(id);
        if (resolver.resultOf(s.station, s.date).status == IIsothermResolver.Status.None) return;
        address actor = _holder(s, actorSeed, false);
        yesAmt = bound(yesAmt, 0, s.yes.balanceOf(actor));
        noAmt = bound(noAmt, 0, s.no.balanceOf(actor));
        if (yesAmt == 0 && noAmt == 0) return;
        (uint256 yh, uint256 nh) = vault.payoutHalves(id);
        uint256 expected = (yesAmt * yh + noAmt * nh) / 2;
        uint256 before = ausd.balanceOf(actor);
        vm.prank(actor);
        uint256 paid = vault.redeem(id, yesAmt, noAmt);
        if (paid != expected || ausd.balanceOf(actor) - before != paid) payoutMismatches++;
        if (yesAmt == noAmt && paid != yesAmt) fullSetMismatches++; // complete sets pay exactly 1 each
        ghostPaidOut += paid;
        ghostPaid[id] += paid;
        calls["redeem"]++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 3 hours));
        calls["warp"]++;
    }

    // --- helpers -----------------------------------------------------------------------------------

    function seriesCount() external view returns (uint256) {
        return seriesIds.length;
    }

    function ladderCount() external view returns (uint256) {
        return ladders.length;
    }

    function _snapshot(LadderKey memory l) internal {
        resolvedSnapshot[keccak256(abi.encode(l.station, l.date))] =
            keccak256(abi.encode(resolver.resultOf(l.station, l.date)));
    }

    /// @dev First actor (scanning from `seed`) holding YES or NO (or both when `both`), else actors[seed].
    function _holder(StrikeFactory.Series memory s, uint256 seed, bool both) internal view returns (address) {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[(seed % actors.length + i) % actors.length];
            uint256 y = s.yes.balanceOf(a);
            uint256 n = s.no.balanceOf(a);
            if (both ? (y > 0 && n > 0) : (y > 0 || n > 0)) return a;
        }
        return actors[seed % actors.length];
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract VaultInvariantTest is Test {
    uint256 internal constant ATTESTER_PK = 0xA11CE;
    uint256 internal constant T0 = 1_791_244_800; // 2026-10-06T00:00:00Z

    MockAUSD ausd;
    Resolver resolver;
    CollateralVault vault;
    VaultHandler handler;

    function setUp() public {
        vm.warp(T0);
        address owner = makeAddr("owner");
        address forwarder = makeAddr("forwarder");
        ausd = new MockAUSD();
        resolver = new Resolver(owner, forwarder, vm.addr(ATTESTER_PK), owner);
        vault = new CollateralVault(owner, resolver, ausd, owner);

        VaultHandler.LadderKey[] memory ls = new VaultHandler.LadderKey[](4);
        ls[0] = VaultHandler.LadderKey("RCSS", 20261007);
        ls[1] = VaultHandler.LadderKey("RJTT", 20261007);
        ls[2] = VaultHandler.LadderKey("RCSS", 20261008);
        ls[3] = VaultHandler.LadderKey("RJTT", 20261010);

        vm.startPrank(owner);
        resolver.registerStation("RCSS", 8 hours);
        resolver.registerStation("RJTT", 9 hours);
        bytes32[] memory ids = new bytes32[](9);
        int16[9] memory ks = [int16(28), 30, 32, 22, 25, 29, 31, -2, 0];
        uint256[9] memory lad = [uint256(0), 0, 0, 1, 1, 2, 2, 3, 3];
        for (uint256 i; i < 9; ++i) {
            VaultHandler.LadderKey memory l = ls[lad[i]];
            uint64 close = uint64(resolver.dayEnd(l.station, l.date) - 2 hours);
            ids[i] = vault.createSeries(l.station, l.date, ks[i], close);
        }
        vm.stopPrank();

        handler = new VaultHandler(vault, resolver, ausd, ATTESTER_PK, forwarder, ids, ls);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = VaultHandler.mintSet.selector;
        sel[1] = VaultHandler.redeemSet.selector;
        sel[2] = VaultHandler.transfer.selector;
        sel[3] = VaultHandler.settle.selector;
        sel[4] = VaultHandler.voidStale.selector;
        sel[5] = VaultHandler.redeem.selector;
        sel[6] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// Vault AUSD balance equals the sum of per-series collateral (no untracked inflow/outflow).
    function invariant_balanceMatchesAccounting() public view {
        uint256 sum;
        for (uint256 i; i < handler.seriesCount(); ++i) {
            sum += vault.getSeries(handler.seriesIds(i)).collateral;
        }
        assertEq(ausd.balanceOf(address(vault)), sum);
    }

    /// Solvency: each series' collateral covers its outstanding liability.
    ///   unresolved: YES supply == NO supply == collateral (only complete sets exist)
    ///   resolved:   2 * collateral >= yesHalves * YES supply + noHalves * NO supply
    function invariant_solvency() public view {
        for (uint256 i; i < handler.seriesCount(); ++i) {
            bytes32 id = handler.seriesIds(i);
            StrikeFactory.Series memory s = vault.getSeries(id);
            uint256 ys = s.yes.totalSupply();
            uint256 ns = s.no.totalSupply();
            if (resolver.resultOf(s.station, s.date).status == IIsothermResolver.Status.None) {
                assertEq(ys, ns);
                assertEq(ys, s.collateral);
            } else {
                (uint256 yh, uint256 nh) = vault.payoutHalves(id);
                assertGe(2 * s.collateral, yh * ys + nh * ns);
            }
        }
    }

    /// Conservation: everything deposited is either still in the vault or was paid out; per series, payouts never
    /// exceed deposits (no double redeem, no cross-series leakage).
    function invariant_conservation() public view {
        assertEq(handler.ghostDeposited(), ausd.balanceOf(address(vault)) + handler.ghostPaidOut());
        for (uint256 i; i < handler.seriesCount(); ++i) {
            bytes32 id = handler.seriesIds(i);
            assertLe(handler.ghostPaid(id), handler.ghostMinted(id));
        }
    }

    /// YES + NO of one set always pays exactly 1 AUSD, and every redemption pays exactly the documented rule.
    function invariant_payoutRules() public view {
        assertEq(handler.fullSetMismatches(), 0);
        assertEq(handler.payoutMismatches(), 0);
    }

    /// Results are write-once.
    function invariant_resultsFinal() public view {
        for (uint256 i; i < handler.ladderCount(); ++i) {
            (bytes4 st, uint32 d) = handler.ladders(i);
            bytes32 snap = handler.resolvedSnapshot(keccak256(abi.encode(st, d)));
            if (snap != bytes32(0)) assertEq(keccak256(abi.encode(resolver.resultOf(st, d))), snap);
        }
    }

    /// Coverage evidence (printed with -vv): how many times each action actually executed (not skipped), summed
    /// over all runs of the campaign. EVM state resets between runs, so the running total is carried in an env var.
    function afterInvariant() external {
        string[6] memory names = ["mintSet", "redeemSet", "transfer", "settle", "voidStale", "redeem"];
        string memory line = "executed (all runs):";
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat("ISO_INV_", names[i]);
            uint256 total = vm.envOr(key, uint256(0)) + handler.calls(names[i]);
            vm.setEnv(key, vm.toString(total));
            line = string.concat(line, " ", names[i], "=", vm.toString(total));
        }
        console2.log(line);
    }
}
