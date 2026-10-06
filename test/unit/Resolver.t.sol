// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IsoTest} from "../utils/IsoTest.sol";
import {Resolver} from "../../src/Resolver.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {StationTime} from "../../src/lib/StationTime.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ResolverTest is IsoTest {
    bytes32 internal constant SRC = keccak256("iem+awc");

    event LadderResolved(
        bytes4 indexed station,
        uint32 indexed date,
        IIsothermResolver.Status status,
        int16 tmaxC,
        bytes32 sourcesHash,
        address caller
    );

    function _metadata(bytes32 wfId, address wfOwner) internal pure returns (bytes memory) {
        // production KeystoneForwarder layout: workflowId(32) | workflowName(10) | workflowOwner(20) | reportId(2)
        return abi.encodePacked(wfId, bytes10("isotherm01"), wfOwner, bytes2(0x0001));
    }

    // --- ERC-165 / interface -----------------------------------------------------------------------

    function test_supportsInterface() public view {
        assertEq(type(IReceiver).interfaceId, bytes4(0x805f2132)); // == onReport(bytes,bytes) selector
        assertTrue(resolver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(resolver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(resolver.supportsInterface(0xffffffff));
        assertFalse(resolver.supportsInterface(0x12345678));
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(Resolver.ZeroAddress.selector);
        new Resolver(owner, address(0), attester, guardian);
        vm.expectRevert(Resolver.ZeroAddress.selector);
        new Resolver(owner, forwarder, address(0), guardian);
    }

    // --- happy path --------------------------------------------------------------------------------

    function test_settle() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.expectEmit(address(resolver));
        emit LadderResolved(RCSS, D, IIsothermResolver.Status.Settled, 31, SRC, forwarder);
        _deliver(rep);
        IIsothermResolver.Result memory r = resolver.resultOf(RCSS, D);
        assertEq(uint8(r.status), uint8(IIsothermResolver.Status.Settled));
        assertEq(r.tmaxC, 31);
        assertEq(r.resolvedAt, RCSS_DAY_END);
        assertEq(r.sourcesHash, SRC);
    }

    function test_settleBoundsInclusive() public {
        vm.warp(RCSS_DAY_END);
        _deliver(_report(RCSS, D, 70, false, SRC));
        vm.warp(RJTT_DAY_END + 1 days);
        _deliver(_report(RJTT, 20261008, -90, false, SRC));
        assertEq(resolver.resultOf(RJTT, 20261008).tmaxC, -90);
    }

    function test_voidReport() public {
        vm.warp(RCSS_DAY_END + 3 hours);
        _deliver(_report(RCSS, D, 29, true, SRC)); // tmax is ignored for void
        IIsothermResolver.Result memory r = resolver.resultOf(RCSS, D);
        assertEq(uint8(r.status), uint8(IIsothermResolver.Status.Void));
        assertEq(r.tmaxC, 0);
    }

    // --- forwarder / metadata ----------------------------------------------------------------------

    function test_rejectsNonForwarder() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidSender.selector, alice, forwarder));
        resolver.onReport(new bytes(64), rep);
    }

    function test_setForwarder() public {
        address prodForwarder = makeAddr("keystone");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        resolver.setForwarder(prodForwarder);
        vm.prank(owner);
        vm.expectRevert(Resolver.ZeroAddress.selector);
        resolver.setForwarder(address(0));
        vm.prank(owner);
        resolver.setForwarder(prodForwarder);
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidSender.selector, forwarder, prodForwarder));
        _deliver(rep); // old forwarder no longer accepted
        vm.prank(prodForwarder);
        resolver.onReport(new bytes(64), rep);
    }

    function test_workflowMetadataChecks() public {
        bytes32 wf = keccak256("workflow");
        address wfOwner = makeAddr("wfOwner");
        vm.prank(owner);
        resolver.setExpectedWorkflow(wf, wfOwner);
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);

        vm.startPrank(forwarder);
        vm.expectRevert(Resolver.InvalidMetadata.selector);
        resolver.onReport(new bytes(61), rep);
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidWorkflowId.selector, bytes32(uint256(1)), wf));
        resolver.onReport(_metadata(bytes32(uint256(1)), wfOwner), rep);
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidWorkflowOwner.selector, alice, wfOwner));
        resolver.onReport(_metadata(wf, alice), rep);
        resolver.onReport(_metadata(wf, wfOwner), rep); // 64-byte production layout accepted
        vm.stopPrank();
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Settled));
    }

    function test_metadataIgnoredWhenNotPinned() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.prank(forwarder);
        resolver.onReport("", rep); // MockKeystoneForwarder gives no identity
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Settled));
    }

    // --- attestation -------------------------------------------------------------------------------

    function test_rejectsWrongSigner() public {
        vm.warp(RCSS_DAY_END);
        uint256 evilPk = 0xE71;
        bytes memory sig = _sign(evilPk, resolver.settlementDigest(RCSS, D, 31, false, SRC));
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidAttestation.selector, vm.addr(evilPk)));
        _deliver(abi.encode(RCSS, D, int16(31), false, SRC, sig));
    }

    function test_rejectsTamperedPayload() public {
        vm.warp(RCSS_DAY_END);
        bytes memory sig = _sign(ATTESTER_PK, resolver.settlementDigest(RCSS, D, 31, false, SRC));
        // same signature, different tmax / void flag / sources / date: recovers some other address
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(abi.encode(RCSS, D, int16(32), false, SRC, sig));
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(abi.encode(RCSS, D, int16(31), true, SRC, sig));
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(abi.encode(RCSS, D, int16(31), false, bytes32(0), sig));
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(abi.encode(RJTT, D, int16(31), false, SRC, sig));
    }

    function test_rejectsMalformedSignature() public {
        vm.warp(RCSS_DAY_END);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        _deliver(abi.encode(RCSS, D, int16(31), false, SRC, bytes("")));
        // high-s (malleable) signature is rejected
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, resolver.settlementDigest(RCSS, D, 31, false, SRC));
        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(uint256(n) - uint256(s));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        _deliver(abi.encode(RCSS, D, int16(31), false, SRC, abi.encodePacked(r, highS, v == 27 ? 28 : 27)));
    }

    function test_signatureBoundToResolverAndChain() public {
        Resolver other = new Resolver(owner, forwarder, attester, guardian);
        vm.prank(owner);
        other.registerStation(RCSS, TPE);
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC); // signed for `resolver`
        vm.prank(forwarder);
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        other.onReport("", rep);

        uint256 originalChain = block.chainid;
        vm.chainId(143); // same contract, different chain
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(rep);
        vm.chainId(originalChain);
        _deliver(rep);
    }

    function test_digestMatchesManualEip712() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Isotherm Resolver"),
                keccak256("1"),
                block.chainid,
                address(resolver)
            )
        );
        assertEq(resolver.domainSeparator(), domain);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)"),
                RCSS,
                D,
                int16(-5),
                false,
                SRC
            )
        );
        assertEq(
            resolver.settlementDigest(RCSS, D, -5, false, SRC),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    function test_attestationToggleRequiresWorkflowId() public {
        vm.startPrank(owner);
        vm.expectRevert(Resolver.WorkflowIdRequired.selector);
        resolver.setAttestationRequired(false);
        resolver.setExpectedWorkflow(keccak256("wf"), address(0));
        resolver.setAttestationRequired(false);
        vm.expectRevert(Resolver.WorkflowIdRequired.selector);
        resolver.setExpectedWorkflow(bytes32(0), address(0)); // cannot unpin while attestation is off
        vm.stopPrank();

        vm.warp(RCSS_DAY_END);
        vm.prank(forwarder); // unsigned report accepted only with the pinned workflow id
        resolver.onReport(_metadata(keccak256("wf"), address(0)), abi.encode(RCSS, D, int16(30), false, SRC, ""));
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 30);
    }

    function test_setAttester() public {
        uint256 newPk = 0xA22CE;
        vm.prank(owner);
        resolver.setAttester(vm.addr(newPk));
        vm.warp(RCSS_DAY_END);
        bytes memory oldRep = _report(RCSS, D, 31, false, SRC);
        vm.expectPartialRevert(Resolver.InvalidAttestation.selector);
        _deliver(oldRep); // old attester rejected
        bytes memory sig = _sign(newPk, resolver.settlementDigest(RCSS, D, 31, false, SRC));
        _deliver(abi.encode(RCSS, D, int16(31), false, SRC, sig));
        vm.prank(owner);
        vm.expectRevert(Resolver.ZeroAddress.selector);
        resolver.setAttester(address(0));
    }

    // --- timing / replay ---------------------------------------------------------------------------

    function test_rejectsBeforeDayEnd() public {
        vm.warp(RCSS_DAY_END - 1);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.DayNotOver.selector, RCSS, D, RCSS_DAY_END));
        _deliver(rep);
        vm.warp(RCSS_DAY_END);
        _deliver(rep);
    }

    function test_noDoubleSettleOrReplay() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        _deliver(rep);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(rep); // exact replay
        bytes memory contradicting = _report(RCSS, D, 25, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(contradicting); // validly signed contradicting value
        bytes memory voidRep = _report(RCSS, D, 0, true, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        _deliver(voidRep); // void after settle
        vm.warp(RCSS_DAY_END + 2 days);
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        resolver.voidIfStale(RCSS, D);
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 31);
    }

    function test_rejectsUnknownStationAndBadDate() public {
        vm.warp(RCSS_DAY_END + 30 days);
        bytes memory rep = _report("ZGSZ", D, 31, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.UnknownStation.selector, bytes4("ZGSZ")));
        _deliver(rep);
        rep = _report(RCSS, 20261032, 31, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidDate.selector, uint32(20261032)));
        _deliver(rep);
    }

    function test_rejectsTmaxOutOfRange() public {
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 71, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.TmaxOutOfRange.selector, int16(71)));
        _deliver(rep);
        rep = _report(RCSS, D, -91, false, SRC);
        vm.expectRevert(abi.encodeWithSelector(Resolver.TmaxOutOfRange.selector, int16(-91)));
        _deliver(rep);
    }

    // --- stale void --------------------------------------------------------------------------------

    function test_voidIfStale() public {
        uint256 staleAt = RCSS_DAY_END + 24 hours;
        vm.warp(staleAt - 1);
        vm.expectRevert(abi.encodeWithSelector(Resolver.NotStale.selector, RCSS, D, staleAt));
        resolver.voidIfStale(RCSS, D);
        vm.warp(staleAt);
        vm.prank(alice); // anyone
        resolver.voidIfStale(RCSS, D);
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
        vm.expectRevert(abi.encodeWithSelector(Resolver.AlreadyResolved.selector, RCSS, D));
        resolver.voidIfStale(RCSS, D);
    }

    function test_lateReportStillAcceptedIfNotVoided() public {
        vm.warp(RCSS_DAY_END + 30 hours);
        _deliver(_report(RCSS, D, 28, false, SRC));
        assertEq(resolver.resultOf(RCSS, D).tmaxC, 28);
    }

    function test_voidIfStaleUnknownStation() public {
        vm.expectRevert(abi.encodeWithSelector(Resolver.UnknownStation.selector, bytes4("ZGSZ")));
        resolver.voidIfStale("ZGSZ", D);
    }

    // --- pause -------------------------------------------------------------------------------------

    function test_pause() public {
        vm.prank(alice);
        vm.expectRevert(Resolver.NotGuardian.selector);
        resolver.pause();
        vm.prank(guardian);
        resolver.pause();
        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, 31, false, SRC);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deliver(rep);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        resolver.unpause();
        vm.prank(owner);
        resolver.unpause();
        _deliver(rep);
    }

    function test_staleVoidWorksWhilePaused() public {
        vm.prank(owner);
        resolver.pause();
        vm.warp(RCSS_DAY_END + 24 hours);
        resolver.voidIfStale(RCSS, D);
        assertEq(uint8(_status(RCSS, D)), uint8(IIsothermResolver.Status.Void));
    }

    // --- stations / admin --------------------------------------------------------------------------

    function test_registerStation() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(Resolver.StationAlreadyRegistered.selector, RCSS));
        resolver.registerStation(RCSS, 9 hours); // write-once: windows can never move
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidStationCode.selector, bytes4("zgsz")));
        resolver.registerStation("zgsz", 8 hours);
        vm.expectRevert(abi.encodeWithSelector(StationTime.InvalidUtcOffset.selector, int32(8 hours + 60)));
        resolver.registerStation("ZGSZ", 8 hours + 60);
        resolver.registerStation("ZGSZ", 8 hours);
        vm.stopPrank();
        (int32 off, bool reg) = resolver.stations("ZGSZ");
        assertEq(off, 8 hours);
        assertTrue(reg);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        resolver.registerStation("RKSI", 9 hours);
    }

    function test_dayEnd() public view {
        assertEq(resolver.dayEnd(RCSS, D), RCSS_DAY_END);
        assertEq(resolver.dayEnd(RJTT, D), RJTT_DAY_END);
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        resolver.transferOwnership(alice);
        assertEq(resolver.owner(), owner);
        vm.prank(alice);
        resolver.acceptOwnership();
        assertEq(resolver.owner(), alice);
    }

    function test_guardianAdmin() public {
        vm.prank(owner);
        resolver.setGuardian(bob);
        vm.prank(guardian);
        vm.expectRevert(Resolver.NotGuardian.selector);
        resolver.pause();
        vm.prank(bob);
        resolver.pause();
        assertTrue(resolver.paused());
    }

    // --- fuzz --------------------------------------------------------------------------------------

    function testFuzz_onlyAttesterSignatureAccepted(uint256 pk, int16 tmax) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        tmax = int16(bound(tmax, -90, 70));
        vm.warp(RCSS_DAY_END);
        bytes memory sig = _sign(pk, resolver.settlementDigest(RCSS, D, tmax, false, SRC));
        bytes memory rep = abi.encode(RCSS, D, tmax, false, SRC, sig);
        if (pk != ATTESTER_PK) {
            vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidAttestation.selector, vm.addr(pk)));
        }
        _deliver(rep);
        if (pk == ATTESTER_PK) assertEq(resolver.resultOf(RCSS, D).tmaxC, tmax);
        else assertEq(uint8(_status(RCSS, D)), 0);
    }
}
