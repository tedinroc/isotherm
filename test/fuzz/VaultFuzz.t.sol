// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IsoTest} from "../utils/IsoTest.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";

contract VaultFuzzTest is IsoTest {
    /// @dev Whatever the outcome, YES + NO of one set pay exactly 1 AUSD; split across holders the total is
    ///      within 1 base unit per holder-leg of rounding (void only) and never exceeds what was deposited.
    function testFuzz_setPaysExactlyOne(uint256 amount, uint256 split, int16 tmax, int16 strike, bool isVoid) public {
        amount = bound(amount, 1, 1e15); // up to 1e9 AUSD
        split = bound(split, 0, amount);
        tmax = int16(bound(tmax, -90, 70));
        strike = int16(bound(strike, -90, 70));
        bytes32 id = _create(RCSS, D, strike);
        (OutcomeToken yes,) = _tokens(id);
        _mint(alice, id, amount);
        vm.prank(alice);
        yes.transfer(bob, split); // bob holds `split` YES, alice holds the rest of YES and all NO

        vm.warp(RCSS_DAY_END);
        bytes memory rep = _report(RCSS, D, tmax, isVoid, keccak256("s"));
        _deliver(rep);

        uint256 preview = vault.previewRedeem(id, amount, amount);
        assertEq(preview, amount, "full set must preview to exactly 1 AUSD per set");

        uint256 paid;
        if (split > 0) {
            vm.prank(bob);
            paid += vault.redeem(id, split, 0);
        }
        vm.prank(alice);
        paid += vault.redeem(id, amount - split, amount);

        assertLe(paid, amount, "never pays more than deposited");
        if (!isVoid) assertEq(paid, amount, "settled sets pay exactly");
        else assertGe(paid + 1, amount, "void rounding loses at most 1 base unit here");
        assertEq(ausd.balanceOf(address(vault)), amount - paid);
        assertEq(vault.getSeries(id).collateral, amount - paid);
        if (!isVoid) {
            uint256 yesPaid = split + 0; // bob's YES leg
            if (tmax >= strike) assertEq(ausd.balanceOf(bob), yesPaid);
            else assertEq(ausd.balanceOf(bob), 0);
        }
    }

    function testFuzz_payoutRule(int16 tmax, int16 strike) public {
        tmax = int16(bound(tmax, -90, 70));
        strike = int16(bound(strike, -90, 70));
        bytes32 id = _create(RCSS, D, strike);
        _settle(RCSS, D, tmax);
        (uint256 y, uint256 n) = vault.payoutHalves(id);
        if (tmax >= strike) {
            assertEq(y, 2);
            assertEq(n, 0);
        } else {
            assertEq(y, 0);
            assertEq(n, 2);
        }
    }

    function testFuzz_mintRedeemSetRoundTrip(uint256 amount, uint256 back, bool afterResolution) public {
        amount = bound(amount, 1, 1e15);
        back = bound(back, 1, amount);
        bytes32 id = _create(RCSS, D, 30);
        _mint(alice, id, amount);
        if (afterResolution) _settle(RCSS, D, 31);
        vm.prank(alice);
        vault.redeemSet(id, back);
        assertEq(ausd.balanceOf(alice), back);
        assertEq(vault.getSeries(id).collateral, amount - back);
        (OutcomeToken yes, OutcomeToken no) = _tokens(id);
        assertEq(yes.totalSupply(), amount - back);
        assertEq(no.totalSupply(), amount - back);
    }

    function testFuzz_cannotMintAfterClose(uint256 dt) public {
        bytes32 id = _create(RCSS, D, 30);
        uint64 close = vault.getSeries(id).closeTime;
        dt = bound(dt, 0, 400 days);
        vm.warp(uint256(close) + dt);
        _fund(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert();
        vault.mintSet(id, 1e6);
    }
}
