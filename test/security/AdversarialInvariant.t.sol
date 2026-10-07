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

/// @dev Honest users trade while an attacker (who also holds positions) keeps trying to break settlement or the
///      vault. Every attacker action is wrapped in try/catch: a success is COUNTED, never reverted, so
///      `invariant_noAttackEverSucceeded` fails loudly if any of them gets through.
contract AttackHandler is Test {
    struct Ladder {
        bytes4 station;
        uint32 date;
    }

    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    CollateralVault public vault;
    Resolver public resolver;
    MockAUSD public ausd;
    uint256 internal attesterPk;
    address internal forwarder;
    address public attacker = makeAddr("attacker");
    address[3] internal users;
    bytes32[] public ids;
    Ladder[] internal ladders;
    bytes[] internal accepted; // honest reports that landed (for replay attempts)

    uint256 public attackSuccesses;
    uint256 public attackAttempts;
    uint256 public ghostDeposited;
    uint256 public ghostPaid;
    mapping(bytes32 ladderKey => bytes32) public resultSnapshot;
    mapping(string => uint256) public calls;

    constructor(
        CollateralVault v,
        Resolver r,
        MockAUSD a,
        uint256 pk,
        address fwd,
        bytes32[] memory ids_,
        Ladder[] memory ladders_
    ) {
        (vault, resolver, ausd, attesterPk, forwarder) = (v, r, a, pk, fwd);
        ids = ids_;
        for (uint256 i; i < ladders_.length; ++i) {
            ladders.push(ladders_[i]);
        }
        users = [makeAddr("u0"), makeAddr("u1"), attacker];
        for (uint256 i; i < 3; ++i) {
            vm.prank(users[i]);
            ausd.approve(address(vault), type(uint256).max);
        }
    }

    // --- honest actions (the attacker is users[2] and also trades) --------------------------------

    function mint(uint256 who, uint256 s, uint256 amt) external {
        address u = users[who % 3];
        bytes32 id = ids[s % ids.length];
        if (block.timestamp >= vault.getSeries(id).closeTime) return;
        amt = bound(amt, 1, 1e12);
        ausd.mint(u, amt);
        vm.prank(u);
        vault.mintSet(id, amt);
        ghostDeposited += amt;
        calls["mint"]++;
    }

    function redeemSet(uint256 who, uint256 s, uint256 amt) external {
        address u = users[who % 3];
        StrikeFactory.Series memory se = vault.getSeries(ids[s % ids.length]);
        uint256 max = _min(se.yes.balanceOf(u), se.no.balanceOf(u));
        if (max == 0) return;
        amt = bound(amt, 1, max);
        vm.prank(u);
        vault.redeemSet(ids[s % ids.length], amt);
        ghostPaid += amt;
        calls["redeemSet"]++;
    }

    function redeem(uint256 who, uint256 s, uint256 y, uint256 n) external {
        address u = users[who % 3];
        bytes32 id = ids[s % ids.length];
        StrikeFactory.Series memory se = vault.getSeries(id);
        if (!resolver.isFinal(se.station, se.date)) return;
        y = bound(y, 0, se.yes.balanceOf(u));
        n = bound(n, 0, se.no.balanceOf(u));
        if (y + n == 0) return;
        vm.prank(u);
        ghostPaid += vault.redeem(id, y, n);
        calls["redeem"]++;
    }

    function transfer(uint256 from, uint256 to, uint256 s, bool isYes, uint256 amt) external {
        address f = users[from % 3];
        StrikeFactory.Series memory se = vault.getSeries(ids[s % ids.length]);
        OutcomeToken t = isYes ? se.yes : se.no;
        uint256 bal = t.balanceOf(f);
        if (bal == 0) return;
        vm.prank(f);
        t.transfer(users[to % 3], bound(amt, 1, bal));
        calls["transfer"]++;
    }

    function settle(uint256 l, int16 tmax, bool isVoid) external {
        Ladder memory L = ladders[l % ladders.length];
        if (block.timestamp < resolver.dayEnd(L.station, L.date)) return;
        if (resolver.resultOf(L.station, L.date).status != IIsothermResolver.Status.None) return;
        tmax = int16(bound(tmax, -90, 70));
        bytes32 src = keccak256(abi.encode(L.station, L.date, tmax));
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory rep = abi.encode(
            L.station, L.date, tmax, isVoid, src, vu, _sig(attesterPk, L.station, L.date, tmax, isVoid, src, vu)
        );
        vm.prank(forwarder);
        resolver.onReport(new bytes(64), rep);
        accepted.push(rep);
        IIsothermResolver.Result memory r = resolver.resultOf(L.station, L.date);
        resultSnapshot[_key(L)] = keccak256(abi.encode(r));
        calls["settle"]++;
    }

    function voidStale(uint256 l) external {
        Ladder memory L = ladders[l % ladders.length];
        if (block.timestamp < resolver.staleAt(L.station, L.date)) return;
        if (resolver.resultOf(L.station, L.date).status != IIsothermResolver.Status.None) return;
        resolver.voidIfStale(L.station, L.date);
        resultSnapshot[_key(L)] = keccak256(abi.encode(resolver.resultOf(L.station, L.date)));
        calls["voidStale"]++;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 12 hours));
        vm.roll(block.number + 1);
        calls["warp"]++;
    }

    // --- attacks -------------------------------------------------------------------------------------

    /// Report signed by a key that is not the attester (random key, or the attester's malleable twin).
    function atkForgedReport(uint256 l, int16 tmax, bool isVoid, uint256 pkSeed, bool useTwin) external {
        Ladder memory L = ladders[l % ladders.length];
        tmax = int16(bound(tmax, -90, 70));
        bytes32 src = keccak256("forged");
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory sig;
        if (useTwin) {
            sig = _twin(_sig(attesterPk, L.station, L.date, tmax, isVoid, src, vu));
        } else {
            uint256 pk = bound(pkSeed, 1, SECP256K1_N - 1);
            if (pk == attesterPk) pk = attesterPk + 1;
            sig = _sig(pk, L.station, L.date, tmax, isVoid, src, vu);
        }
        bytes memory rep = abi.encode(L.station, L.date, tmax, isVoid, src, vu, sig);
        _attempt(address(resolver), forwarder, abi.encodeCall(Resolver.onReport, (new bytes(64), rep)));
        calls["atkForged"]++;
    }

    /// (r, s, v) -> (r, n - s, v ^ 1): the same key's malleable twin.
    function _twin(bytes memory sig) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = abi.decode(sig, (bytes32, bytes32));
        uint8 v = uint8(sig[64]);
        return abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    /// Replay an accepted honest report, either as-is or re-targeted at another (station, date) with the same signature.
    function atkReplay(uint256 i, uint256 l) external {
        if (accepted.length == 0) return;
        bytes memory rep = accepted[i % accepted.length];
        (,, int16 tmax, bool isVoid, bytes32 src, uint64 vu, bytes memory sig) =
            abi.decode(rep, (bytes4, uint32, int16, bool, bytes32, uint64, bytes));
        Ladder memory L = ladders[l % ladders.length];
        _attempt(address(resolver), forwarder, abi.encodeCall(Resolver.onReport, (new bytes(64), rep)));
        _attempt(
            address(resolver),
            forwarder,
            abi.encodeCall(
                Resolver.onReport, (new bytes(64), abi.encode(L.station, L.date, tmax, isVoid, src, vu, sig))
            )
        );
        calls["atkReplay"]++;
    }

    /// A validly signed report, but sent straight to the Resolver instead of through the forwarder.
    function atkDirectOnReport(uint256 l, int16 tmax) external {
        Ladder memory L = ladders[l % ladders.length];
        tmax = int16(bound(tmax, -90, 70));
        bytes32 src = keccak256("direct");
        uint64 vu = uint64(block.timestamp + 1 hours);
        bytes memory rep = abi.encode(
            L.station, L.date, tmax, false, src, vu, _sig(attesterPk, L.station, L.date, tmax, false, src, vu)
        );
        _attempt(address(resolver), attacker, abi.encodeCall(Resolver.onReport, (new bytes(64), rep)));
        calls["atkDirect"]++;
    }

    /// A genuine attester signature that has already expired (validUntil in the past), delivered via the forwarder.
    function atkExpiredReport(uint256 l, int16 tmax, uint256 age) external {
        Ladder memory L = ladders[l % ladders.length];
        tmax = int16(bound(tmax, -90, 70));
        bytes32 src = keccak256("expired");
        uint64 vu = uint64(block.timestamp - bound(age, 1, 1 days));
        bytes memory rep =
            abi.encode(L.station, L.date, tmax, false, src, vu, _sig(attesterPk, L.station, L.date, tmax, false, src, vu));
        _attempt(address(resolver), forwarder, abi.encodeCall(Resolver.onReport, (new bytes(64), rep)));
        calls["atkExpired"]++;
    }

    /// One-sided redeem while a Settled result is still inside its challenge window.
    function atkEarlyRedeem(uint256 s) external {
        bytes32 id = ids[s % ids.length];
        StrikeFactory.Series memory se = vault.getSeries(id);
        IIsothermResolver.Result memory r = resolver.resultOf(se.station, se.date);
        if (r.status == IIsothermResolver.Status.None || block.timestamp >= r.finalAt) return;
        uint256 y = se.yes.balanceOf(attacker);
        uint256 n = se.no.balanceOf(attacker);
        if (y == n) y += 1; // never a pure complete-set amount (that path is redeemSet, always allowed)
        _attempt(address(vault), attacker, abi.encodeCall(CollateralVault.redeem, (id, y, n)));
        calls["atkEarlyRedeem"]++;
    }

    /// Challenge (veto to void) from a non-guardian.
    function atkChallenge(uint256 l) external {
        Ladder memory L = ladders[l % ladders.length];
        _attempt(address(resolver), attacker, abi.encodeCall(Resolver.challenge, (L.station, L.date, bytes32(0))));
        calls["atkChallenge"]++;
    }

    /// Gasless EIP-3009 mint of a victim's AUSD with a garbage signature.
    function atkAuthorizationWithGarbage(uint256 s, bytes32 r, bytes32 sv) external {
        bytes32 id = ids[s % ids.length];
        _attempt(
            address(vault),
            attacker,
            abi.encodeCall(
                CollateralVault.mintSetWithAuthorization, (id, 1e6, users[0], 0, type(uint256).max, r, 27, r, sv)
            )
        );
        calls["atkAuth"]++;
    }

    /// Redeem / redeemSet more than held (by 1..1e12 units).
    function atkOverRedeem(uint256 s, uint256 extra, bool viaSet) external {
        bytes32 id = ids[s % ids.length];
        StrikeFactory.Series memory se = vault.getSeries(id);
        extra = bound(extra, 1, 1e12);
        if (viaSet) {
            uint256 amt = _min(se.yes.balanceOf(attacker), se.no.balanceOf(attacker)) + extra;
            _attempt(address(vault), attacker, abi.encodeCall(CollateralVault.redeemSet, (id, amt)));
        } else {
            if (resolver.resultOf(se.station, se.date).status == IIsothermResolver.Status.None) return;
            _attempt(
                address(vault),
                attacker,
                abi.encodeCall(CollateralVault.redeem, (id, se.yes.balanceOf(attacker) + extra, 0))
            );
        }
        calls["atkOverRedeem"]++;
    }

    /// Mint or burn outcome tokens directly, or call the bare implementation.
    function atkTokenMintBurn(uint256 s, uint256 amt, bool burnVictim) external {
        StrikeFactory.Series memory se = vault.getSeries(ids[s % ids.length]);
        amt = bound(amt, 1, 1e12);
        bytes memory data = burnVictim
            ? abi.encodeCall(OutcomeToken.burn, (users[0], amt))
            : abi.encodeCall(OutcomeToken.mint, (attacker, amt));
        _attempt(address(se.yes), attacker, data);
        _attempt(address(se.no), attacker, data);
        _attempt(vault.tokenImplementation(), attacker, data);
        calls["atkToken"]++;
    }

    /// Void a ladder before its stale window.
    function atkEarlyVoid(uint256 l) external {
        Ladder memory L = ladders[l % ladders.length];
        if (block.timestamp >= resolver.staleAt(L.station, L.date)) return;
        _attempt(address(resolver), attacker, abi.encodeCall(Resolver.voidIfStale, (L.station, L.date)));
        calls["atkEarlyVoid"]++;
    }

    /// Spend a victim's standing allowance through mintSetWithPermit with a garbage signature.
    function atkPermitWithGarbage(uint256 s, bytes32 r, bytes32 sv) external {
        bytes32 id = ids[s % ids.length];
        _attempt(
            address(vault),
            attacker,
            abi.encodeCall(CollateralVault.mintSetWithPermit, (id, 1e6, users[0], block.timestamp + 1, 27, r, sv))
        );
        calls["atkPermit"]++;
    }

    /// Admin calls from the attacker.
    function atkAdmin(uint256 which) external {
        bytes memory data;
        address target = address(resolver);
        which %= 6;
        if (which == 0) {
            data = abi.encodeCall(Resolver.setAttester, (attacker));
        } else if (which == 1) {
            data = abi.encodeCall(Resolver.setForwarder, (attacker));
        } else if (which == 2) {
            data = abi.encodeCall(Resolver.pause, ());
        } else if (which == 3) {
            data = abi.encodeCall(Resolver.registerStation, (bytes4("EVIL"), int32(0)));
        } else if (which == 4) {
            (target, data) = (address(vault), abi.encodeCall(StrikeFactory.setOperator, (attacker, true)));
        } else {
            (target, data) = (address(vault), abi.encodeCall(CollateralVault.pause, ()));
        }
        _attempt(target, attacker, data);
        calls["atkAdmin"]++;
    }

    // --- helpers -------------------------------------------------------------------------------------

    function _attempt(address target, address from, bytes memory data) internal {
        attackAttempts++;
        uint256 balBefore = ausd.balanceOf(attacker);
        vm.prank(from);
        (bool ok,) = target.call(data);
        if (ok) {
            attackSuccesses++;
            console2.log("ATTACK SUCCEEDED", target);
            console2.logBytes(data);
        }
        assertEq(ausd.balanceOf(attacker), balBefore, "attack moved AUSD");
    }

    function _sig(uint256 pk, bytes4 st, uint32 dt, int16 t, bool v, bytes32 src, uint64 vu)
        internal
        view
        returns (bytes memory)
    {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, resolver.settlementDigest(st, dt, t, v, src, vu));
        return abi.encodePacked(r, s, vv);
    }

    function _key(Ladder memory L) internal pure returns (bytes32) {
        return keccak256(abi.encode(L.station, L.date));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function ladderAt(uint256 i) external view returns (bytes4, uint32) {
        return (ladders[i].station, ladders[i].date);
    }

    function laddersLength() external view returns (uint256) {
        return ladders.length;
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 96
contract AdversarialInvariantTest is Test {
    AttackHandler internal h;
    CollateralVault internal vault;
    Resolver internal resolver;
    MockAUSD internal ausd;

    function setUp() public {
        vm.warp(1_791_244_800); // 2026-10-06T00:00:00Z
        uint256 pk = 0xA11CE;
        address fwd = makeAddr("forwarder");
        address owner = makeAddr("owner");
        ausd = new MockAUSD();
        resolver = new Resolver(owner, fwd, vm.addr(pk), owner, 15 minutes);
        vault = new CollateralVault(owner, resolver, ausd, owner);
        vm.startPrank(owner);
        resolver.registerStation("RCSS", 8 hours);
        resolver.registerStation("RJTT", 9 hours);
        AttackHandler.Ladder[] memory ls = new AttackHandler.Ladder[](3);
        ls[0] = AttackHandler.Ladder("RCSS", 20261007);
        ls[1] = AttackHandler.Ladder("RJTT", 20261007);
        ls[2] = AttackHandler.Ladder("RCSS", 20261008);
        bytes32[] memory ids = new bytes32[](6);
        int16[3] memory k = [int16(28), 30, 32];
        for (uint256 i; i < 3; ++i) {
            uint64 close = uint64(resolver.dayEnd(ls[i].station, ls[i].date) - 1 hours);
            ids[2 * i] = vault.createSeries(ls[i].station, ls[i].date, k[i], close);
            ids[2 * i + 1] = vault.createSeries(ls[i].station, ls[i].date, k[i] - 3, close);
        }
        vm.stopPrank();
        vm.warp(1_791_244_800 + 30 hours); // 9h before the first ladders close: runs reach settlement and staleness
        h = new AttackHandler(vault, resolver, ausd, pk, fwd, ids, ls);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](20);
        sel[0] = AttackHandler.mint.selector;
        sel[1] = AttackHandler.redeemSet.selector;
        sel[2] = AttackHandler.redeem.selector;
        sel[3] = AttackHandler.transfer.selector;
        sel[4] = AttackHandler.settle.selector;
        sel[5] = AttackHandler.voidStale.selector;
        sel[6] = AttackHandler.warp.selector;
        sel[7] = AttackHandler.atkForgedReport.selector;
        sel[8] = AttackHandler.atkReplay.selector;
        sel[9] = AttackHandler.atkDirectOnReport.selector;
        sel[10] = AttackHandler.atkOverRedeem.selector;
        sel[11] = AttackHandler.atkTokenMintBurn.selector;
        sel[12] = AttackHandler.atkEarlyVoid.selector;
        sel[13] = AttackHandler.atkPermitWithGarbage.selector;
        sel[14] = AttackHandler.atkAdmin.selector;
        sel[15] = AttackHandler.warp.selector; // double weight on time so ladders actually resolve
        sel[16] = AttackHandler.atkExpiredReport.selector;
        sel[17] = AttackHandler.atkEarlyRedeem.selector;
        sel[18] = AttackHandler.atkChallenge.selector;
        sel[19] = AttackHandler.atkAuthorizationWithGarbage.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_noAttackEverSucceeded() public view {
        assertEq(h.attackSuccesses(), 0);
    }

    function invariant_vaultBalanceEqualsBooks() public view {
        uint256 sum;
        for (uint256 i; i < h.idsLength(); ++i) {
            sum += vault.getSeries(h.ids(i)).collateral;
        }
        assertEq(ausd.balanceOf(address(vault)), sum);
        assertEq(h.ghostDeposited() - h.ghostPaid(), sum, "deposits - payouts == reserves");
    }

    function invariant_everySeriesCoversItsClaims() public view {
        for (uint256 i; i < h.idsLength(); ++i) {
            StrikeFactory.Series memory s = vault.getSeries(h.ids(i));
            uint256 y = s.yes.totalSupply();
            uint256 n = s.no.totalSupply();
            IIsothermResolver.Result memory r = resolver.resultOf(s.station, s.date);
            uint256 claim;
            if (r.status == IIsothermResolver.Status.None) claim = y > n ? y : n;
            else if (r.status == IIsothermResolver.Status.Void) claim = (y + n + 1) / 2;
            else claim = r.tmaxC >= s.strikeC ? y : n;
            assertGe(s.collateral, claim);
        }
    }

    function invariant_resultsNeverChange() public view {
        for (uint256 i; i < h.laddersLength(); ++i) {
            (bytes4 st, uint32 dt) = h.ladderAt(i);
            bytes32 snap = h.resultSnapshot(keccak256(abi.encode(st, dt)));
            IIsothermResolver.Result memory r = resolver.resultOf(st, dt);
            if (snap == bytes32(0)) assertEq(uint8(r.status), 0, "resolved without an honest action");
            else assertEq(keccak256(abi.encode(r)), snap);
        }
    }

    /// Deterministic walk through every handler path (proves the settlement-phase attacks really execute rather than
    /// early-returning): mint, settle, then every attack after resolution, then redeem.
    function test_handlerPathsAllExecute() public {
        for (uint256 i; i < 3; ++i) {
            h.mint(i, 0, 100e6);
        }
        h.mint(2, 1, 50e6);
        h.atkForgedReport(0, 31, false, 0xBAD, false);
        h.atkForgedReport(0, 31, false, 0, true);
        h.warp(12 hours);
        h.settle(0, 29, false); // RCSS 20261007 settled at 29 (strikes 28 YES-wins, 25 YES-wins)
        h.atkEarlyRedeem(0); // inside the 15-minute challenge window
        h.atkEarlyRedeem(1);
        h.atkChallenge(0);
        h.atkExpiredReport(1, 20, 60);
        h.atkAuthorizationWithGarbage(2, bytes32(uint256(1)), bytes32(uint256(2)));
        h.atkReplay(0, 0);
        h.atkReplay(0, 1);
        h.atkReplay(0, 2);
        h.atkDirectOnReport(1, 20);
        h.atkOverRedeem(0, 1, true);
        h.atkOverRedeem(0, 1, false);
        h.atkTokenMintBurn(0, 5, true);
        h.atkTokenMintBurn(0, 5, false);
        h.atkEarlyVoid(1);
        h.atkPermitWithGarbage(2, bytes32(uint256(1)), bytes32(uint256(2)));
        for (uint256 i; i < 6; ++i) {
            h.atkAdmin(i);
        }
        h.warp(1 hours); // challenge window over
        h.redeem(2, 0, type(uint256).max, type(uint256).max);
        h.redeem(0, 0, type(uint256).max, 0);
        for (uint256 i; i < 4; ++i) {
            h.warp(12 hours);
        }
        h.voidStale(1); // RJTT 20261007, no report for 48h
        h.redeem(1, 0, 0, 0);
        assertEq(h.calls("settle"), 1);
        assertEq(h.calls("voidStale"), 1);
        assertEq(h.calls("redeem"), 2, "two redemptions paid");
        assertEq(h.calls("atkEarlyRedeem"), 2, "early-redeem attacks really ran inside the window");
        assertEq(h.attackSuccesses(), 0);
        assertGt(h.attackAttempts(), 20);
        invariant_vaultBalanceEqualsBooks();
        invariant_everySeriesCoversItsClaims();
        invariant_resultsNeverChange();
    }

    function afterInvariant() public view {
        console2.log("attack attempts", h.attackAttempts(), "successes", h.attackSuccesses());
        console2.log("forged", h.calls("atkForged"), "replay", h.calls("atkReplay"));
        console2.log("expired", h.calls("atkExpired"), "earlyRedeem", h.calls("atkEarlyRedeem"));
        console2.log("settle", h.calls("settle"), "voidStale", h.calls("voidStale"));
        console2.log("redeem", h.calls("redeem"), "mint", h.calls("mint"));
    }
}
