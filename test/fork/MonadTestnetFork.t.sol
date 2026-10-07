// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";

import {Resolver} from "../../src/Resolver.sol";
import {CollateralVault} from "../../src/CollateralVault.sol";
import {StrikeFactory} from "../../src/StrikeFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IIsothermResolver} from "../../src/interfaces/IIsothermResolver.sol";
import {CivilDate} from "../utils/CivilDate.sol";

interface IAusdFaucet {
    function requestFunds(address to) external;
}

interface IKeystoneForwarderLike {
    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata sigs)
        external;
    function typeAndVersion() external view returns (string memory);
}

/// @notice Critical path against LIVE Monad testnet (10143) state on a local fork:
///         real testnet AUSD + its faucet, real Chainlink CRE MockKeystoneForwarder, real KeystoneForwarder.
/// Run:  MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz forge test --match-path test/fork/* -vv
///       (optionally FORK_BLOCK=<n> to pin a block and cache RPC responses). Skipped when the env var is absent.
contract MonadTestnetForkTest is Test {
    IERC20 constant AUSD = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    IAusdFaucet constant FAUCET = IAusdFaucet(0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C);
    IKeystoneForwarderLike constant MOCK_FWD = IKeystoneForwarderLike(0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    IKeystoneForwarderLike constant PROD_FWD = IKeystoneForwarderLike(0xF8344CFd5c43616a4366C34E3EEE75af79a74482);

    bytes4 constant RCSS = "RCSS";
    int32 constant TPE = 8 hours;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant ATTESTER_PK = 0xA11CE; // test-only key
    uint256 constant USER_PK = 0xB0B0B; // test-only key

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address relayer = makeAddr("relayer");
    address cre = makeAddr("creTransmitter");
    address user;

    Resolver resolver;
    CollateralVault vault;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        user = vm.addr(USER_PK);
        resolver = new Resolver(owner, address(MOCK_FWD), vm.addr(ATTESTER_PK), owner, 15 minutes);
        vault = new CollateralVault(owner, resolver, AUSD, owner);
        vm.startPrank(owner);
        resolver.registerStation(RCSS, TPE);
        vault.setOperator(operator, true);
        vm.stopPrank();
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_liveContracts() public onlyFork {
        assertEq(block.chainid, 10143);
        assertEq(IERC20Metadata(address(AUSD)).decimals(), 6);
        (, string memory name, string memory version, uint256 chainId, address vc,,) =
            IERC5267(address(AUSD)).eip712Domain();
        assertEq(name, "Agora Dollar");
        assertEq(version, "1");
        assertEq(chainId, 10143);
        assertEq(vc, address(AUSD));
        assertEq(MOCK_FWD.typeAndVersion(), "MockKeystoneForwarder 1.0.0");
        assertEq(PROD_FWD.typeAndVersion(), "KeystoneForwarder 1.0.0");
        console2.log("fork block", block.number, "timestamp", block.timestamp);
    }

    // state shared by the critical-path steps (avoids stack-too-deep)
    uint32 date;
    uint256 dayEnd;
    bytes32[] ids;
    bytes32 id30;
    bytes32 constant SRC = keccak256("iem:RCSS max 31 | awc:RCSS max 31");

    /// Full lifecycle with real testnet AUSD and the real CRE simulation forwarder.
    function test_fork_criticalPath() public onlyFork {
        _step1_faucet();
        _step2_ladder();
        _step3_mint();
        _step4_permitMint();
        _step4b_authorizationMint();
        _step5_redeemSet();
        _step6_settleViaMockForwarder();
        _step7_redeem();
    }

    function _step1_faucet() internal {
        uint256 before = AUSD.balanceOf(user);
        vm.prank(user);
        FAUCET.requestFunds(user);
        uint256 got = AUSD.balanceOf(user) - before;
        console2.log("faucet.requestFunds gave (AUSD base units)", got);
        assertGt(got, 0);
    }

    function _step2_ladder() internal {
        date = CivilDate.localDate(block.timestamp + 1 days, TPE); // tomorrow in Taipei
        dayEnd = resolver.dayEnd(RCSS, date);
        int16[] memory ks = new int16[](6);
        for (uint256 i; i < 6; ++i) {
            ks[i] = int16(int256(27 + i)); // 27..32
        }
        vm.prank(operator);
        ids = vault.createLadder(RCSS, date, ks, uint64(dayEnd - 1 hours));
        id30 = ids[3];
        StrikeFactory.Series memory s = vault.getSeries(id30);
        console2.log("ladder RCSS date", date);
        console2.log(string.concat("YES>=30 token ", vm.toString(address(s.yes)), " ", s.yes.symbol()));
    }

    function _step3_mint() internal {
        StrikeFactory.Series memory s = vault.getSeries(id30);
        vm.startPrank(user);
        AUSD.approve(address(vault), 100e6);
        vault.mintSet(id30, 100e6);
        vm.stopPrank();
        assertEq(s.yes.balanceOf(user), 100e6);
        assertEq(s.no.balanceOf(user), 100e6);
    }

    /// Gasless mint: user signs an EIP-2612 permit on REAL AUSD ("Agora Dollar" v1 domain), relayer submits.
    function _step4_permitMint() internal {
        uint256 nonce = IERC20Permit(address(AUSD)).nonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(address(AUSD)).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, user, address(vault), 50e6, nonce, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(USER_PK, digest);
        vm.prank(relayer);
        vault.mintSetWithPermit(id30, 50e6, user, deadline, v, r, ss);
        assertEq(vault.getSeries(id30).yes.balanceOf(user), 150e6);
        assertEq(IERC20Permit(address(AUSD)).nonces(user), nonce + 1);
        assertEq(AUSD.balanceOf(address(vault)), 150e6);
    }

    /// Gasless mint v1: user signs an EIP-3009 ReceiveWithAuthorization on REAL AUSD whose nonce binds the series.
    function _step4b_authorizationMint() internal {
        assertEq(IERC20Permit(address(AUSD)).DOMAIN_SEPARATOR(), _ausdDomain(), "AUSD domain = Agora Dollar v1");
        bytes32 salt = keccak256("fork-salt");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = vault.mintAuthorizationNonce(id30, 20e6, salt);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(address(AUSD)).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RECEIVE_TYPEHASH, user, address(vault), 20e6, 0, validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(USER_PK, digest);
        // a front-runner cannot move it to another series of the ladder
        vm.prank(makeAddr("frontRunner"));
        vm.expectRevert();
        vault.mintSetWithAuthorization(ids[0], 20e6, user, 0, validBefore, salt, v, r, ss);
        vm.prank(relayer);
        vault.mintSetWithAuthorization(id30, 20e6, user, 0, validBefore, salt, v, r, ss);
        assertEq(vault.getSeries(id30).yes.balanceOf(user), 170e6);
        assertEq(AUSD.balanceOf(address(vault)), 170e6);
        (bool ok, bytes memory ret) =
            address(AUSD).staticcall(abi.encodeWithSignature("authorizationState(address,bytes32)", user, nonce));
        assertTrue(ok && abi.decode(ret, (bool)), "nonce consumed on real AUSD");
        console2.log("real AUSD receiveWithAuthorization mint OK, nonce", vm.toString(nonce));
    }

    function _ausdDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Agora Dollar"),
                keccak256("1"),
                block.chainid,
                address(AUSD)
            )
        );
    }

    function _step5_redeemSet() internal {
        vm.prank(user);
        vault.redeemSet(id30, 40e6);
        assertEq(AUSD.balanceOf(address(vault)), 130e6);
    }

    function _step6_settleViaMockForwarder() internal {
        vm.warp(dayEnd + 10 minutes);

        // 6a. forged report (wrong signer): forwarder delivers it, our attestation check rejects it
        bytes memory forged = _rawReport(_payload(date, 35, SRC, 0xBAD), bytes32(uint256(1)));
        vm.recordLogs();
        vm.prank(cre);
        MOCK_FWD.report(address(resolver), forged, "", new bytes[](0));
        assertFalse(_processedResult(), "forwarder must report failure for forged payload");
        assertEq(uint8(resolver.resultOf(RCSS, date).status), uint8(IIsothermResolver.Status.None));

        // 6b. properly attested report settles the whole ladder
        bytes memory good = _rawReport(_payload(date, 31, SRC, ATTESTER_PK), bytes32(uint256(2)));
        vm.recordLogs();
        vm.prank(cre);
        uint256 g0 = gasleft();
        MOCK_FWD.report(address(resolver), good, "", new bytes[](0));
        console2.log("MockKeystoneForwarder.report (incl. onReport) gas, in-test measure", g0 - gasleft());
        assertTrue(_processedResult(), "forwarder must report success");
        IIsothermResolver.Result memory res = resolver.resultOf(RCSS, date);
        assertEq(uint8(res.status), uint8(IIsothermResolver.Status.Settled));
        assertEq(res.tmaxC, 31);

        // 6c. replaying the signed report through the forwarder fails (no double settle)
        bytes memory replay = _rawReport(_payload(date, 31, SRC, ATTESTER_PK), bytes32(uint256(3)));
        vm.recordLogs();
        vm.prank(cre);
        MOCK_FWD.report(address(resolver), replay, "", new bytes[](0));
        assertFalse(_processedResult(), "replay must fail");

        // 6d. nobody can bypass the forwarder
        bytes memory direct = _payload(date, 31, SRC, ATTESTER_PK);
        vm.prank(cre);
        vm.expectRevert(abi.encodeWithSelector(Resolver.InvalidSender.selector, cre, address(MOCK_FWD)));
        resolver.onReport("", direct);
    }

    function _step7_redeem() internal {
        vm.prank(user);
        vm.expectRevert(); // NotFinal: 15-minute challenge window
        vault.redeem(id30, 130e6, 130e6);
        vm.warp(resolver.resultOf(RCSS, date).finalAt);
        uint256 bal0 = AUSD.balanceOf(user);
        vm.prank(user);
        uint256 paid = vault.redeem(id30, 130e6, 130e6); // Tmax 31 >= 30: YES pays 1, NO pays 0
        assertEq(paid, 130e6);
        assertEq(AUSD.balanceOf(user) - bal0, 130e6);
        assertEq(AUSD.balanceOf(address(vault)), 0);
        (uint256 yh32, uint256 nh32) = vault.payoutHalves(ids[5]); // strike 32 > 31: NO wins
        assertEq(yh32, 0);
        assertEq(nh32, 2);
    }

    // --- helpers -----------------------------------------------------------------------------------

    function _payload(uint32 date, int16 tmax, bytes32 src, uint256 signerPk) internal view returns (bytes memory) {
        uint64 vu = uint64(block.timestamp + 30 minutes);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerPk, resolver.settlementDigest(RCSS, date, tmax, false, src, vu));
        return abi.encode(RCSS, date, tmax, false, src, vu, abi.encodePacked(r, s, v));
    }

    /// @dev Keystone rawReport: version(1) | executionId(32) | timestamp(4) | donId(4) | donConfigVersion(4) |
    ///      workflowCid(32) | workflowName(10) | workflowOwner(20) | reportId(2) | report
    function _rawReport(bytes memory report, bytes32 executionId) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(1),
            executionId,
            uint32(block.timestamp),
            uint32(1),
            uint32(1),
            bytes32(0),
            bytes10(0),
            address(0),
            bytes2(0),
            report
        );
    }

    /// @dev Reads the `result` flag of the forwarder's ReportProcessed(receiver, executionId, reportId, result).
    function _processedResult() internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("ReportProcessed(address,bytes32,bytes2,bool)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(MOCK_FWD) && logs[i].topics[0] == topic) {
                return abi.decode(logs[i].data, (bool));
            }
        }
        revert("no ReportProcessed event");
    }
}
