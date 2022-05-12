# Next version

- `approveMangrove` on `OfferLogic` instances may no longer use a custom value.
- Remove instance aliases for stateful static methods in `Mangrove` as the scope of these was misleading: setting a value on one instance would affect all others. The removed methods are: `{get,set}Decimals`, `{get,set}DisplayedDecimals`, and `fetchDecimals`.
- Disable logging by default. It can be turned on by calling `enableLogging()` in `util/logger`. This is a temporary workaround to prevent unwanted logging to the console until issue #220 is fixed.
- `market.subscribe` now returns a user friendly `mgvData` in the case
  of `OfferFail`.

# 0.6.1 (May 2022)

- Update with latest Mumbai address for `MangroveOrder` which uses the latest Mangrove.

# 0.6.0 (May 2022)

- Add support for resting limit orders using `MangroveOrder` contract.

# 0.5.7 (May 2022)

- Update addresses (really this time) to newly deployed Mangrove core contracts (they now match the mangrove.js ABI files)

# 0.5.6 (May 2022)

- Update addresses to newly deployed Mangrove core contracts (they now match the mangrove.js ABI files)

# 0.5.5 (May 2022)

- Fix `Mangrove.getDisplayedPriceDecimals`: It was mistakenly using the configuration for `Mangrove.getDisplayedDecimals` instead of its own configuration.

# 0.5.4 (May 2022)

- Add support for WebSocket URL's in `Mangrove.connect`
- Added two separate features for displaying prices with appropriate numbers of decimals:
  - `Mangrove.{get|set}DisplayedPriceDecimals` gets/set the number of decimals to display for a given token when displayed as a price (the default is 6)
  - `Market.getDisplayDecimalsForPriceDifferences` computes the number of decimals to display in order for the smallest price difference to be visible.

# 0.5.3 (April 2022)

- Adding address and other constants for test MGV token on Mumbai

# 0.5.2 (April 2022)

- `Mangrove.offerLogic` now accepts the name of a predeployed multi user logic (`offerProxy` or `oasisLike` in this version)
- Adding deployed addresses for `offerProxy` and `oasisLike` in `addresses.json`
- New `Market.getGivesWantsForVolumeAtPrice` method that converts a volume (in base tokens) and a price to appropriate gives and wants for either bids or asks.
- Update the number of decimals to display for WETH=4, USDC=2, and DAI=2.

# 0.5.1 (March 2022)

- `addresses.json` points to AAVE-v3 dApp addresses
- Eliminate a Market initialization bug which could cause an error to be thrown [#203](https://github.com/mangrovedao/mangrove/issues/203)

# 0.5.0 (March 2022)

- `addresses.json` points to AAVE-v3 compatible ERC20 addresses on network `maticmum`
- `offerLogic` class is now compatible with multi-makers logics
- ethers.js overrides can now be added to API functions that produce signed transactions
- `mgvToken.contract` accept a wider class of ERC20 (e.g. minting, blacklisting...) for ethers.js calls.
- some bugfixes for various hanging issues

# 0.4.0 (Skipped)

# 0.3.8 (March 2022)

- `Market.OrderResult` now contains the raw `ethers.ContractReceipt`.

# 0.3.7 (March 2022)

- Update address to newly deployed Mangrove core contracts (they now match the mangrove.js ABI files)

# 0.3.6 (March 2022)

This version number was inadvertently skipped.

# 0.3.5 (March 2022)

- Fix: Include root `tsconfig.json` which is referenced from `src/tsconfig.json` (this was causing issues with Vite)
- Fix: Underestimation by estimateGas() when takerWants was low (issue #89).

# 0.3.4 (March 2022)

- Chain-related constants are now in JSON files instead of TypeScript files and thus easily machine readable for other tools

# 0.3.3 (March 2022)

- Following the removing of the new logging feature, a node-only dependency (`config`) has been removed to keep compatibility with browser environment

# 0.3.1 (March 2022)

- The new logging has been stunted: It only logs to the console and without timestamps
  - This is a temporary workaround to issue #220

# 0.2.0 (February 2022)

- New `Market` options:
  - `desiredPrice`: allows one to specify a price point of interest. This will cause the cache to initially load all offers with this price or better.
  - `desiredVolume`: allows one to specify a volume of interest. This will cause the cache to initially load at least this volume (if available). The option uses the same specification as for `estimateVolume`: `desiredVolume: { given: 1, what: "base", to: "buy" }` will cause the asks semibook to be initialized with a volume of at least 1 base token.
- New `Market` subscription: `market.afterBlock(n,callback)` will trigger `callback` after the market events for block `n` have been processed. If the block has already been processed, `callback` will be triggered at the next event loop.
- Improve logging: add file logging, allow applications using the package to configure logging using local `config` file.
- add support for keystore file (json wallet) (`Mangrove.connect(jsonWallet:{path 'path/to/file.json', password: <wallet password>})`)
- New `partialFill` flag in `OrderResult`: This flag will be true if the order was only partially filled.
- New `Market` convenience estimator methods `estimateVolumeTo{Spend,Receive}`.

# 0.1.0 (January 2022)

- `{Market|Semibook}.getPivotId` now fetches offers until a pivot can be determined
- `MarketCallback`s now receive an `ethers.providers.Log` instead of an `ethers.Event`
- 2 new classes `OfferLogic` and `LiquidityProvider`. `OfferLogic` allows one to connect to an onchain offer logic and calls functions of the `IOfferLogic.sol` interface. A `LiquidityProvider` instance is obtained either direclty from a `Mangrove` instance, in which case the liquidity provider is the signer, or from an `OfferLogic` instance, in which case all calls to Mangrove are done via the onchain contract.
- the above classes subsume and replace the old `Maker` class.
- `MgvToken` implements `balanceOf`
- Add experimental CLI: `mgv`. See README.md for instructions
- You can do `market.buy({total: 100, price:null})` on a BAT/DAI market to buy BAT by spending 100 DAI, no (real) price limit. You can also specify a limit average price, and also specify a `total` in quote token on `Market#sell`.

# 0.0.9 (January 2022)

- New Mangrove deployment
- All types now start with upper case
- All functions now start with lower case
- Removed `fromId` and `blockNumber` from `Market.BookOptions`
- `Market.{subscribe|consoleAsks|consoleBids|prettyPrint}` are no longer `async`
- `Market.{getBaseQuoteVolumes|getPrice|getWantsForPrice|getGivesForPrice}` are now `static`
- `Market.Offer.{prev|next}` are now `undefined` (instead of `0`) if there is no previous/next offer
- `Market.getPivot` renamed to `Market.getPivotId`
- `Market.getPivotId` now returns `undefined` (instead of `0`) if no offer with better price exists
- `Market.getPivotId` now throws `Error` if the order book cache is insufficient to determine a pivot

# 0.0.8

- SimpleMaker constructor is called Maker
- `market.consoleAsk` and `market.consoleBids` now allows for pretty printing semi OB
- `bids` and `asks` allows for optional parameters `gasreq` and `gasprice` if one wants to change their values

# 0.0.5 (December 2021)

- Add `bookOptions` to SimpleMaker constructor.
- Allow initializing markets&makers after construction.
- Uncertain pivot ids when pushing an offer will throw.
  - TODO: allow giving bookOptions later
- Calling `maker.approveMangrove(token)` with no specified amount will approve the max amount.
- Add override sto most functions
- User can add slippage limit to market orders

# 0.0.4 (December 2021)

# 0.0.3 (December 2021)

TODO fill in

# 0.0.2 (November 2021)

Initial release
