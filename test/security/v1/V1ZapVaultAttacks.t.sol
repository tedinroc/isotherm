// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IsoTest} from "../../utils/IsoTest.sol";
import {IsothermZap} from "../../../src/IsothermZap.sol";
import {CollateralVault} from "../../../src/CollateralVault.sol";
import {OutcomeToken} from "../../../src/OutcomeToken.sol";
import {IKuruRouterView} from "../../../src/interfaces/IKuru.sol";
import {MockKuruRouter} from "../../unit/IsothermZap.t.sol";

/// @dev Offline order book with several bid levels (best first) owned by different makers, so a sandwich can be
///      modelled: the front-runner sells into the maker's bid and leaves its own low bid behind. Same token flow as
///      Kuru v1 with isMargin = false (input pulled with transferFrom, unfilled input returned, output transferred).
contract LevelBook {
    struct Level {
        uint256 price; // 1e4 precision
        uint256 size; // base units
        address owner;
    }

    IERC20 public immutable base;
    IERC20 public immutable quote;
    Level[] internal _bids;

    constructor(IERC20 b, IERC20 q) {
        (base, quote) = (b, q);
    }

    function bestBid() external view returns (uint256 price, uint256 size) {
        for (uint256 i; i < _bids.length; ++i) {
            if (_bids[i].size != 0) return (_bids[i].price, _bids[i].size);
        }
    }

    function addBid(uint256 price, uint256 size) external {
        quote.transferFrom(msg.sender, address(this), size * price / 1e4);
        _bids.push(Level(price, size, msg.sender));
        for (uint256 i = _bids.length - 1; i > 0 && _bids[i].price > _bids[i - 1].price; --i) {
            Level memory tmp = _bids[i];
            _bids[i] = _bids[i - 1];
            _bids[i - 1] = tmp;
        }
    }

    function placeAndExecuteMarketSell(uint96 size, uint256, bool, bool) external payable returns (uint256 out) {
        base.transferFrom(msg.sender, address(this), size);
        uint256 left = size;
        for (uint256 i; i < _bids.length && left != 0; ++i) {
            Level storage l = _bids[i];
            uint256 f = left < l.size ? left : l.size;
            if (f == 0) continue;
            l.size -= f;
            left -= f;
            out += f * l.price / 1e4;
            base.transfer(l.owner, f);
        }
        if (left != 0) base.transfer(msg.sender, left);
        quote.transfer(msg.sender, out);
    }

    function placeAndExecuteMarketBuy(uint96, uint256, bool, bool) external payable returns (uint256) {
        revert("no asks in this model");
    }
}

/// @notice v1 security diff review: Zap / vault attacks. RESIDUAL_* = still works on the deployed v1 code.
contract V1ZapVaultAttacksTest is IsoTest {
    MockKuruRouter internal router;
    IsothermZap internal zap;
    LevelBook internal book;
    bytes32 internal id;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address internal maker = makeAddr("maker");
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        router = new MockKuruRouter();
        zap = new IsothermZap(IKuruRouterView(address(router)), vault);
        id = _create(RCSS, D, 30);
        (yes, no) = _tokens(id);
        book = new LevelBook(IERC20(address(yes)), ausd);
        router.set(
            address(book),
            MockKuruRouter.Info({
                pp: 1e4,
                sp: 1e6,
                base: address(yes),
                baseDec: 6,
                quote: address(ausd),
                quoteDec: 6,
                takerFee: 10,
                makerFee: 0
            })
        );
        vm.prank(operator);
        zap.setCanonicalMarket(id, address(book));
        // maker's resting bid: 100 YES @ 0.43 (P(YES) ~ 0.46)
        ausd.mint(maker, 43e6);
        vm.startPrank(maker);
        ausd.approve(address(book), type(uint256).max);
        book.addBid(4300, 100e6);
        vm.stopPrank();
    }

    /// RESIDUAL (Medium, new in the v1 Zap): Zap.buyNo bounds only `ausdBack` = sale proceeds + AUSD from merging the
    /// UNSOLD YES back. A sandwich that removes the maker's bid and leaves a tiny 0.001 bid makes the Zap sell only
    /// part of the YES at ~0 and merge the rest at par, so ausdBack still clears the victim's min while the victim
    /// pays ~0.999 per NO instead of ~0.57 and gets half the NO. buyYes and sellYes are properly bounded; buyNo is not
    /// (there is no minNoOut). Fix needs a Zap redeploy: add `minNoOut` (and/or require full fill).
    function test_RESIDUAL_buyNoSandwich_minAusdBackPassesAtTerriblePrice() public {
        // victim quotes off the visible book: sell 100 YES @ 0.43 -> 43 AUSD back, 2% slippage -> min 42.14
        (uint256 bidPx, uint256 bidSz) = book.bestBid();
        assertEq(bidPx, 4300);
        assertEq(bidSz, 100e6);
        uint256 ausdIn = 100e6;
        uint256 minBack = ausdIn * bidPx / 1e4 * 98 / 100;
        assertEq(minBack, 42_140_000);

        // front-run: attacker mints 100 sets, dumps the YES into the maker's bid, rests a 50 YES bid at 0.001
        ausd.mint(attacker, 101e6);
        vm.startPrank(attacker);
        ausd.approve(address(vault), type(uint256).max);
        ausd.approve(address(book), type(uint256).max);
        yes.approve(address(book), type(uint256).max);
        vault.mintSet(id, 100e6);
        book.placeAndExecuteMarketSell(100e6, 0, false, false); // +43 AUSD, fair for the attacker
        book.addBid(10, 50e6); // 0.05 AUSD
        vm.stopPrank();

        // victim's buyNo lands next
        ausd.mint(alice, ausdIn);
        vm.startPrank(alice);
        ausd.approve(address(zap), type(uint256).max);
        (uint256 noOut, uint256 ausdBack) = zap.buyNo(id, address(book), ausdIn, minBack, alice);
        vm.stopPrank();

        assertGe(ausdBack, minBack, "the only on-chain bound is satisfied");
        assertEq(noOut, 50e6, "half the NO the quote promised");
        uint256 paid = ausdIn - ausdBack;
        assertEq(paid, 49_950_000);
        uint256 pricePerNo = paid * 1e6 / noOut;
        assertGt(pricePerNo, 0.99e6, "victim paid > 0.99 per NO");
        // what the victim was quoted: 100 NO for 57 AUSD = 0.57 per NO
        assertEq((ausdIn - ausdIn * bidPx / 1e4) * 1e6 / ausdIn, 0.57e6);
        // attacker now holds 50 YES bought at 0.001 (worth ~0.46 each) on top of its 100 NO
        assertEq(yes.balanceOf(attacker), 50e6);
        assertEq(no.balanceOf(attacker), 100e6);
    }

    /// The no-redeploy mitigation for the web/plugin: mint the set in the vault, then Zap.sellYes with a proper
    /// minAusdOut. sellYes' bound IS a worst-case bound (you never get less than minAusdOut for at most yesIn), so the
    /// same sandwich reverts instead of filling.
    function test_mitigation_mintSetPlusSellYesIsProtectedAgainstTheSameSandwich() public {
        uint256 minBack = 42_140_000;
        ausd.mint(attacker, 101e6);
        vm.startPrank(attacker);
        ausd.approve(address(vault), type(uint256).max);
        ausd.approve(address(book), type(uint256).max);
        yes.approve(address(book), type(uint256).max);
        vault.mintSet(id, 100e6);
        book.placeAndExecuteMarketSell(100e6, 0, false, false);
        book.addBid(10, 50e6);
        vm.stopPrank();

        _mint(alice, id, 100e6);
        vm.startPrank(alice);
        yes.approve(address(zap), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IsothermZap.Slippage.selector, 50_000, minBack));
        zap.sellYes(id, address(book), 100e6, minBack, alice);
        vm.stopPrank();
    }

    /// INFO: the compliance gate checks the RECIPIENT of a mint only. If the owner ever allowlists a router (the Zap,
    /// to let allowlisted users trade through it), every non-allowlisted user gets primary exposure via Zap.buyNo.
    function test_INFO_gateIsRecipientBased_anAllowlistedRouterOpensIt() public {
        vm.prank(owner);
        vault.setSeriesGated(id, true);
        _fund(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NotAllowlisted.selector, id, alice));
        vault.mintSet(id, 10e6);
        vm.prank(owner);
        vault.setAllowlisted(address(zap), true);
        ausd.mint(alice, 10e6);
        vm.startPrank(alice);
        ausd.approve(address(zap), type(uint256).max);
        (uint256 noOut,) = zap.buyNo(id, address(book), 10e6, 1, alice);
        vm.stopPrank();
        assertEq(noOut, 10e6, "non-allowlisted alice minted NO of a gated series via the Zap");
    }

    /// HOLDS: an EIP-3009 authorization is bound to the vault INSTANCE (to == vault, payee == caller). A redeployed
    /// vault (same AUSD, same seriesId - seriesId does not include the vault address) cannot consume an
    /// authorization signed for the live vault, and nobody can route it there.
    function test_HOLDS_authorizationBoundToVaultInstanceAcrossRedeploys() public {
        CollateralVault vault2 = new CollateralVault(owner, resolver, ausd, guardian);
        vm.prank(owner);
        vault2.setOperator(operator, true);
        uint64 close = vault.getSeries(id).closeTime;
        vm.prank(operator);
        bytes32 id2 = vault2.createSeries(RCSS, D, 30, close);
        assertEq(id2, id, "seriesId is the same in both vaults");

        uint256 pk = 0xD1A;
        address holder = vm.addr(pk);
        ausd.mint(holder, 50e6);
        bytes32 salt = keccak256("s");
        uint256 vb = block.timestamp + 15 minutes;
        bytes32 nonce = vault.mintAuthorizationNonce(id, 50e6, salt);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                ),
                holder,
                address(vault),
                uint256(50e6),
                uint256(0),
                vb,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), sh)));
        vm.prank(attacker);
        vm.expectRevert("FiatTokenV2: invalid signature");
        vault2.mintSetWithAuthorization(id2, 50e6, holder, 0, vb, salt, v, r, s);
        vm.prank(attacker);
        vault.mintSetWithAuthorization(id, 50e6, holder, 0, vb, salt, v, r, s); // anyone may relay to the right vault
        assertEq(yes.balanceOf(holder), 50e6);
        assertEq(yes.balanceOf(attacker), 0);
    }
}
