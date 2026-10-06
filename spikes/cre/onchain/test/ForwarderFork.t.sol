// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Resolver} from "isotherm/Resolver.sol";
import {IIsothermResolver} from "isotherm/interfaces/IIsothermResolver.sol";
import {IReceiver} from "isotherm/interfaces/IReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {CreReport} from "../src/CreReport.sol";

interface IForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata signatures)
        external;
    function typeAndVersion() external view returns (string memory);
}

/// @dev Records exactly what a forwarder hands to a CRE receiver.
contract ProbeReceiver is IReceiver {
    bytes public lastMetadata;
    bytes public lastReport;
    address public lastSender;

    function onReport(bytes calldata metadata, bytes calldata report) external {
        lastMetadata = metadata;
        lastReport = report;
        lastSender = msg.sender;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IReceiver).interfaceId || id == type(IERC165).interfaceId;
    }
}

/// Run against a fork of Monad testnet 10143 (live MockKeystoneForwarder / KeystoneForwarder code):
///   forge test --fork-url http://127.0.0.1:18845 -vv        (anvil --fork-url https://testnet-rpc.monad.xyz)
contract ForwarderForkTest is Test {
    IForwarder constant MOCK = IForwarder(0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    IForwarder constant PROD = IForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482);
    // Address the TS workflow test signed its EIP-712 attestation for (fixtures/report_RCSS_2026-10-05.json).
    address constant RESOLVER_ADDR = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    // Throwaway public test key (anvil account #9) == ATTESTER in workflow.test.ts.
    uint256 constant ATTESTER_PK = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;
    bytes4 constant RCSS = "RCSS";

    Resolver resolver;
    address attester;
    bytes tsPayload;

    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function setUp() public {
        require(block.chainid == 10143, "run with --fork-url <Monad testnet fork>");
        attester = vm.addr(ATTESTER_PK);
        deployCodeTo("Resolver.sol:Resolver", abi.encode(address(this), address(MOCK), attester, address(this)), RESOLVER_ADDR);
        resolver = Resolver(RESOLVER_ADDR);
        resolver.registerStation(RCSS, 8 hours);
        string memory json = vm.readFile("../project/settle/fixtures/report_RCSS_2026-10-05.json");
        tsPayload = vm.parseJsonBytes(json, ".payload");
    }

    function _raw(bytes memory payload, bytes32 execId) internal pure returns (bytes memory) {
        bytes memory h = CreReport.header(
            execId,
            1,
            1,
            CreReport.SIM_WORKFLOW_ID,
            CreReport.encodeName("isotherm-settle"),
            CreReport.SIM_WORKFLOW_OWNER,
            CreReport.SIM_REPORT_ID
        );
        assertEq(h.length, 109);
        return bytes.concat(h, payload);
    }

    function test_liveForwardersIdentity() public view {
        assertEq(MOCK.typeAndVersion(), "MockKeystoneForwarder 1.0.0");
        assertEq(PROD.typeAndVersion(), "KeystoneForwarder 1.0.0");
    }

    /// The exact bytes the TS workflow produced settle the builder's Resolver through the real MockKeystoneForwarder,
    /// sent by an arbitrary EOA (the mock is permissionless).
    function test_tsReport_settlesThroughMockForwarder() public {
        address anyone = makeAddr("anyone");
        bytes memory raw = _raw(tsPayload, keccak256("exec-1"));
        vm.expectEmit(true, true, true, true, address(MOCK));
        emit ReportProcessed(RESOLVER_ADDR, keccak256("exec-1"), bytes2(0x0001), true);
        vm.prank(anyone, anyone);
        uint256 g0 = gasleft();
        MOCK.report(RESOLVER_ADDR, raw, "", new bytes[](0));
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas: MockKeystoneForwarder.report -> Resolver.onReport (in-call, warm calldata)", used);

        IIsothermResolver.Result memory r = resolver.resultOf(RCSS, 20261005);
        assertEq(uint8(r.status), uint8(IIsothermResolver.Status.Settled));
        assertEq(r.tmaxC, 29);
    }

    /// What the mock forwarder actually hands the receiver: metadata = rawReport[45:109] (64 bytes, NOT empty),
    /// report = rawReport[109:], msg.sender = the forwarder itself.
    function test_mockForwarder_metadataShape() public {
        ProbeReceiver probe = new ProbeReceiver();
        bytes memory raw = _raw(tsPayload, keccak256("exec-2"));
        MOCK.report(address(probe), raw, "", new bytes[](0));
        bytes memory md = probe.lastMetadata();
        assertEq(md.length, 64);
        assertEq(probe.lastSender(), address(MOCK));
        assertEq(keccak256(probe.lastReport()), keccak256(tsPayload));
        bytes32 wfId;
        bytes10 wfName;
        address wfOwner;
        bytes2 reportId;
        assembly {
            wfId := mload(add(md, 32))
            wfName := mload(add(md, 64))
            wfOwner := shr(96, mload(add(md, 74)))
            reportId := mload(add(md, 94))
        }
        assertEq(wfId, CreReport.SIM_WORKFLOW_ID);
        assertEq(wfName, CreReport.encodeName("isotherm-settle"));
        assertEq(wfOwner, CreReport.SIM_WORKFLOW_OWNER);
        assertEq(reportId, bytes2(0x0001));
        emit log_named_bytes("metadata passed by MockKeystoneForwarder", md);
    }

    /// A forged report (wrong attester) is REJECTED by the Resolver, but the forwarder tx still SUCCEEDS:
    /// the mock swallows the revert and emits ReportProcessed(result=false). The CRE simulator would print
    /// "transaction succeeded" here — check the Resolver's state/event, not the tx status.
    function test_forgedReport_rejectedButTxSucceeds() public {
        (bytes4 st, uint32 date, int16 t, bool v, bytes32 sh,) =
            abi.decode(tsPayload, (bytes4, uint32, int16, bool, bytes32, bytes));
        (uint8 pv, bytes32 r, bytes32 s) = vm.sign(0xBAD, resolver.settlementDigest(st, date, 40, v, sh));
        bytes memory forged = abi.encode(st, date, int16(40), v, sh, abi.encodePacked(r, s, pv));
        t;
        vm.expectEmit(true, true, true, true, address(MOCK));
        emit ReportProcessed(RESOLVER_ADDR, keccak256("exec-3"), bytes2(0x0001), false);
        MOCK.report(RESOLVER_ADDR, _raw(forged, keccak256("exec-3")), "", new bytes[](0));
        assertEq(uint8(resolver.resultOf(RCSS, 20261005).status), uint8(IIsothermResolver.Status.None));
    }

    /// Replaying the same signed report (new execution id) is swallowed too: Resolver is write-once.
    function test_replay_rejected() public {
        MOCK.report(RESOLVER_ADDR, _raw(tsPayload, keccak256("exec-4")), "", new bytes[](0));
        vm.expectEmit(true, true, true, true, address(MOCK));
        emit ReportProcessed(RESOLVER_ADDR, keccak256("exec-5"), bytes2(0x0001), false);
        MOCK.report(RESOLVER_ADDR, _raw(tsPayload, keccak256("exec-5")), "", new bytes[](0));
    }

    /// Bypassing the forwarder entirely is blocked by the Resolver's sender check.
    function test_directOnReport_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidSender.selector, address(this), address(MOCK)));
        resolver.onReport(new bytes(64), tsPayload);
    }

    /// The production KeystoneForwarder is NOT permissionless: without valid DON signatures it reverts.
    function test_productionForwarder_requiresDonSignatures() public {
        bytes memory raw = _raw(tsPayload, keccak256("exec-6"));
        vm.expectRevert();
        PROD.report(RESOLVER_ADDR, raw, new bytes(96), new bytes[](0));
    }
}
