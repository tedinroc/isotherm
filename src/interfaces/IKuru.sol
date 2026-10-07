// SPDX-License-Identifier: GPL-2.0-or-later
// Trimmed from spikes/kuru/src/interfaces/IKuru.sol, itself derived from github.com/Kuru-Labs/Kuru-contracts-dex-public
// (contracts/interfaces/IRouter.sol + IOrderBook.sol, commit 2060bb2, GPL-2.0-or-later). The declarations match Kuru's;
// verifiedMarket's return names are Kuru's MarketParams fields. Parameter names and comments were rewritten. The copy
// verified on Sourcify for the deployed IsothermZap carries the earlier "MIT" SPDX line; only this header differs.
// Full license text: LICENSES/GPL-2.0-or-later.txt at the repository root.
pragma solidity ^0.8.28;

/// @dev Minimal Kuru v1 surface used by the Zap (selectors checked against the live Monad-testnet bytecode by the
///      Kuru spike; Router 0x7EFbE105Ca7415dE98F96622173458ac1c054630).
interface IKuruRouterView {
    function verifiedMarket(address market)
        external
        view
        returns (
            uint32 pricePrecision,
            uint96 sizePrecision,
            address baseAssetAddress,
            uint256 baseAssetDecimals,
            address quoteAssetAddress,
            uint256 quoteAssetDecimals,
            uint32 tickSize,
            uint96 minSize,
            uint96 maxSize,
            uint256 takerFeeBps,
            uint256 makerFeeBps
        );
}

interface IKuruOrderBookTaker {
    /// `quoteSize` in pricePrecision units; `isMargin=false` pulls quote from msg.sender and pays base to msg.sender.
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
    /// `size` in sizePrecision units; pays quote to msg.sender.
    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
}
