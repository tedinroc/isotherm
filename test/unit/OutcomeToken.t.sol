// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IsoTest} from "../utils/IsoTest.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract OutcomeTokenTest is IsoTest {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function test_metadata() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        assertEq(yes.name(), "Isotherm RCSS 20261007 Tmax>=30C YES");
        assertEq(no.name(), "Isotherm RCSS 20261007 Tmax>=30C NO");
        assertEq(yes.symbol(), "RCSS-20261007-GE30-Y");
        assertEq(no.symbol(), "RCSS-20261007-GE30-N");
        assertEq(yes.decimals(), 6);
        assertEq(yes.vault(), address(vault));
        (bytes32 sid, bytes4 st, uint32 date, int16 k, bool isYes) = yes.seriesInfo();
        assertEq(sid, id);
        assertEq(st, RCSS);
        assertEq(date, D);
        assertEq(k, 30);
        assertTrue(isYes);
        (,,,, isYes) = no.seriesInfo();
        assertFalse(isYes);
    }

    function test_negativeStrikeNames() public {
        bytes32 id = _create(RJTT, D, -3);
        (OutcomeToken yes,) = _tokens(id);
        assertEq(yes.name(), "Isotherm RJTT 20261007 Tmax>=-3C YES");
        assertEq(yes.symbol(), "RJTT-20261007-GE-3-Y");
    }

    function test_implementationIsInert() public {
        OutcomeToken impl = OutcomeToken(vault.tokenImplementation());
        assertEq(impl.name(), "Isotherm Outcome (implementation)");
        assertEq(impl.symbol(), "ISO-IMPL");
        (bytes32 sid,,,,) = impl.seriesInfo();
        assertEq(sid, bytes32(0));
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        impl.mint(alice, 1);
    }

    function test_predictedAddresses() public {
        address py = vault.predictTokenAddress(RCSS, D, 31, true);
        address pn = vault.predictTokenAddress(RCSS, D, 31, false);
        bytes32 id = _create(RCSS, D, 31);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        assertEq(address(yes), py);
        assertEq(address(no), pn);
        assertTrue(py != pn);
    }

    function test_onlyVaultMintBurn() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes,) = _tokens(id);
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        yes.mint(alice, 1e6);
        _mint(alice, id, 5e6);
        vm.prank(alice);
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        yes.burn(alice, 1e6);
        vm.prank(address(vault));
        yes.burn(alice, 1e6);
        assertEq(yes.balanceOf(alice), 4e6);
    }

    function test_permitOnClone() public {
        bytes32 idA = _create(RCSS, D, 30);
        bytes32 idB = _create(RCSS, D, 31);
        (OutcomeToken yesA,) = _tokens(idA);
        (OutcomeToken yesB,) = _tokens(idB);
        uint256 pk = 0xB0B;
        address holder = vm.addr(pk);

        // ERC-5267: shared name/version, per-clone verifyingContract
        (, string memory n, string memory v, uint256 chainId, address vc,,) = yesA.eip712Domain();
        assertEq(n, "Isotherm Outcome");
        assertEq(v, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(yesA));
        assertTrue(yesA.DOMAIN_SEPARATOR() != yesB.DOMAIN_SEPARATOR());

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, holder, bob, 7e6, 0, deadline));
        (uint8 pv, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", yesA.DOMAIN_SEPARATOR(), structHash)));

        // The same signature is useless on a sibling clone (different verifyingContract).
        vm.expectRevert();
        yesB.permit(holder, bob, 7e6, deadline, pv, r, s);

        yesA.permit(holder, bob, 7e6, deadline, pv, r, s);
        assertEq(yesA.allowance(holder, bob), 7e6);
        assertEq(yesA.nonces(holder), 1);

        // replay fails (nonce consumed)
        vm.expectRevert();
        yesA.permit(holder, bob, 7e6, deadline, pv, r, s);
    }

    function test_transferable() public {
        bytes32 id = _create(RCSS, D, 30);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        _mint(alice, id, 10e6);
        vm.prank(alice);
        yes.transfer(bob, 4e6);
        assertEq(yes.balanceOf(bob), 4e6);
        assertEq(no.balanceOf(alice), 10e6);
        assertEq(yes.totalSupply(), 10e6);
    }
}
