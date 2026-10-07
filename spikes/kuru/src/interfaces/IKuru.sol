// SPDX-License-Identifier: GPL-2.0-or-later
// Minimal Kuru v1 interfaces, derived from github.com/Kuru-Labs/Kuru-contracts-dex-public
// (contracts/interfaces/*.sol, commit 2060bb2, GPL-2.0-or-later). Every selector below was checked
// against the bytecode of the live Monad-testnet implementations (see spikes/kuru/RESULT.md).
// Full license text: LICENSES/GPL-2.0-or-later.txt at the repository root.
pragma solidity ^0.8.20;

/// @dev OrderBookType: 0 = NO_NATIVE (ERC20/ERC20), 1 = NATIVE_IN_BASE, 2 = NATIVE_IN_QUOTE.
interface IKuruRouter {
    /// Permissionless on Monad TESTNET router 0x7EFbE105Ca7415dE98F96622173458ac1c054630.
    /// Owner-gated (reverts Unauthorized() 0x82b42900) on MAINNET router 0xd651346d7c789536ebf06dc72aE3C8502cd695CC.
    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy);

    /// Multi-hop swap through router-verified markets. Uses fill-or-kill market orders and pays the
    /// output to msg.sender. The user approves the ROUTER for `_debitToken`.
    function anyToAnySwap(
        address[] calldata _marketAddresses,
        bool[] calldata _isBuy,
        bool[] calldata _nativeSend,
        address _debitToken,
        address _creditToken,
        uint256 _amount,
        uint256 _minAmountOut
    ) external payable returns (uint256 _amountOut);

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

    function marginAccountAddress() external view returns (address);

    event MarketRegistered(
        address baseAsset,
        address quoteAsset,
        address market,
        address vaultAddress,
        uint32 pricePrecision,
        uint96 sizePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread
    );
}

interface IKuruOrderBook {
    // ---- maker (all debit/credit the caller's MarginAccount balance) ----
    /// price in pricePrecision units, size in sizePrecision units. postOnly=true reverts if it would cross.
    function addBuyOrder(uint32 _price, uint96 size, bool _postOnly) external;
    function addSellOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    /// Cancels (no revert on already-filled ids), then places bids, then asks — one tx re-quote.
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;
    /// Reverts if any id is already filled/cancelled.
    function batchCancelOrders(uint40[] calldata _orderIds) external;
    /// Skips filled ids; still reverts (OnlyOwnerAllowedError) on ids that were cancelled/deleted.
    function batchCancelOrdersNoRevert(uint40[] calldata _orderIds) external;

    // ---- taker ----
    /// _quoteAmount is in pricePrecision units (AUSD * pricePrecision). _minAmountOut in base-token decimals.
    /// _isMargin=false: pulls quote from msg.sender via transferFrom (approve the MARKET) and pays base to the
    /// msg.sender wallet. Returns base received (base-token decimals, after taker fee).
    function placeAndExecuteMarketBuy(uint96 _quoteAmount, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    /// _size is in sizePrecision units. _minAmountOut in quote-token decimals. Returns quote received.
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);

    // ---- views ----
    /// (bestBid, bestAsk) scaled to 1e18 (vaultPricePrecision). Empty: bid=type(uint256).max, ask=0.
    function bestBidAsk() external view returns (uint256, uint256);
    /// abi `bytes`: [blockNumber][price,size]*bids (desc) [0] [price,size]*asks (asc); each word 32 bytes,
    /// price in pricePrecision units, size in sizePrecision units.
    function getL2Book() external view returns (bytes memory);
    function getL2Book(uint32 _bidPricePoints, uint32 _askPricePoints) external view returns (bytes memory);
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);
    function s_orderIdCounter() external view returns (uint40);
    function s_orders(uint40)
        external
        view
        returns (
            address ownerAddress,
            uint96 size,
            uint40 prev,
            uint40 next,
            uint40 flippedId,
            uint32 price,
            uint32 flippedPrice,
            bool isBuy
        );
    function marketState() external view returns (uint8);

    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    event OrderCanceled(uint40 orderId, address owner, uint32 price, uint96 size, bool isBuy);
    event OrdersCanceled(uint40[] orderId, address owner);
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );
}

interface IKuruMarginAccount {
    /// Anyone may deposit for `_user`; pulls `_amount` of `_token` from msg.sender (approve the MARGIN ACCOUNT).
    function deposit(address _user, address _token, uint256 _amount) external payable;
    function withdraw(uint256 _amount, address _token) external;
    function batchWithdrawMaxTokens(address[] calldata _tokens) external;
    function getBalance(address _user, address _token) external view returns (uint256);
}
