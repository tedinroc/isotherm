// Minimal ABIs the maker needs. Human-readable fragments, so the bot does not break when an unrelated function
// changes. The two places where the feasibility deployment (git 1ae0d48) and v1 differ in shape are kept as
// explicit variants: Series (v1 adds `bool gated`) and Result (v1 adds `uint64 finalAt`).
import { parseAbi } from "viem";

export const vaultCommonAbi = parseAbi([
  "function owner() view returns (address)",
  "function isOperator(address) view returns (bool)",
  "function resolver() view returns (address)",
  "function collateral() view returns (address)",
  "function createLadder(bytes4 station, uint32 date, int16[] strikesC, uint64 closeTime) returns (bytes32[])",
  "function createSeries(bytes4 station, uint32 date, int16 strikeC, uint64 closeTime) returns (bytes32)",
  "function ladderSeries(bytes4 station, uint32 date) view returns (bytes32[])",
  "function seriesIdOf(bytes4 station, uint32 date, int16 strikeC) pure returns (bytes32)",
  "function predictTokenAddress(bytes4 station, uint32 date, int16 strikeC, bool isYes) view returns (address)",
  "function mintSet(bytes32 seriesId, uint256 amount)",
  "function redeemSet(bytes32 seriesId, uint256 amount)",
  "function redeem(bytes32 seriesId, uint256 yesAmount, uint256 noAmount) returns (uint256)",
  "function payoutHalves(bytes32 seriesId) view returns (uint256 yesHalves, uint256 noHalves)",
  "function paused() view returns (bool)",
  "error NotOperator()",
  "error SeriesExists(bytes32 seriesId)",
  "error UnknownSeries(bytes32 seriesId)",
  "error BadCloseTime(uint64 closeTime, uint256 dayEnd)",
  "error MintClosed(bytes32 seriesId, uint64 closeTime)",
  "error NotResolved(bytes32 seriesId)",
  "error EmptyLadder()",
]);

export const seriesAbiV1 = parseAbi([
  "struct Series { bytes4 station; uint32 date; int16 strikeC; uint64 closeTime; bool gated; address yes; address no; uint256 collateral; }",
  "function getSeries(bytes32 seriesId) view returns (Series)",
]);
export const seriesAbiFeasibility = parseAbi([
  "struct Series { bytes4 station; uint32 date; int16 strikeC; uint64 closeTime; address yes; address no; uint256 collateral; }",
  "function getSeries(bytes32 seriesId) view returns (Series)",
]);

export const resolverCommonAbi = parseAbi([
  "function owner() view returns (address)",
  "function dayEnd(bytes4 station, uint32 date) view returns (uint256)",
  "function registerStation(bytes4 station, int32 utcOffset)",
  "error UnknownStation(bytes4 station)",
]);
export const resultAbiV1 = parseAbi([
  "struct Result { uint8 status; int16 tmaxC; uint64 resolvedAt; uint64 finalAt; bytes32 sourcesHash; }",
  "function resultOf(bytes4 station, uint32 date) view returns (Result)",
]);
export const resultAbiFeasibility = parseAbi([
  "struct Result { uint8 status; int16 tmaxC; uint64 resolvedAt; bytes32 sourcesHash; }",
  "function resultOf(bytes4 station, uint32 date) view returns (Result)",
]);

/** v1 Zap canonical-market registry (write-once; vault operator or owner). Absent on the feasibility Zap. */
export const zapRegistryAbi = parseAbi([
  "function canonicalMarket(bytes32 seriesId) view returns (address)",
  "function setCanonicalMarket(bytes32 seriesId, address market)",
  "function validateMarket(bytes32 seriesId, address market) view returns (bool)",
  "error CanonicalMarketAlreadySet(bytes32 seriesId, address market)",
  "error InvalidMarket(address market)",
  "error NotOperator()",
]);

export const kuruRouterAbi = parseAbi([
  "function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address proxy)",
  "function verifiedMarket(address) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
  "error Unauthorized()",
]);

export const kuruBookAbi = parseAbi([
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getL2Book() view returns (bytes)",
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "error InsufficientBalance()",
  "error PostOnlyError()",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
]);

export const marginAbi = parseAbi([
  "function deposit(address _user, address _token, uint256 _amount) payable",
  "function batchWithdrawMaxTokens(address[] _tokens)",
  "function getBalance(address _user, address _token) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function symbol() view returns (string)",
]);

export const faucetAbi = parseAbi(["function requestFunds(address)", "error MaxFrequencyExceeded()"]);

export const ERROR_ABIS = [vaultCommonAbi, resolverCommonAbi, zapRegistryAbi, kuruRouterAbi, kuruBookAbi, faucetAbi];
