# mangrove.js

A JavaScript library for Mangrove. Wraps around [Ethers.js](https://github.com/ethers-io/ethers.js/). Works in the **web browser** and **Node.js**.

This SDK is in **open beta**, and is constantly under development. **USE AT YOUR OWN RISK**.

## Install / Import

### Web Browser

```html
<script
  type="text/javascript"
  src="https://cdn.jsdelivr.net/npm/@mangrovedao/mangrove.js"
></script>

<script type="text/javascript">
  Mangrove.(...)
</script>
```

### Node.js

```
npm install @mangrovedao/mangrove.js
```

```js
const { Mangrove } = require("..."); // cjs
import { Mangrove } from "..."; // or using ES6
```

# Using the API as a liquidity taker

## Connecting the API to a deployed Mangrove contract

```js
// use alchemy or infura to connect to the network
const mgv = await Mangrove.connect({
  provider: process.env.NODE_URL,
  privateKey: process.env.SK,
});
```

## Obtaining a market object

```js
  // Connect to ETH-USDC market
  const market = mgv.market({ base: "ETH", quote: "USDC" });

  // Check allowance
  const allowance = await market.base.allowance(); // by default returns Mangrove allowance for current signer address
  // Set max allowance for Mangrove spending quote tokens on behalf of signer
  await market.quote.approveMangrove();
  // Set specific allowance
  await market.base.approveMangrove(0.42);

    // Read orderbook
  market.book();
  /*
    Returns
    {
      asks: [
        {id: 3, price: 3700, volume: 4, ...},
        {id: 56, price: 3701, volume: 7.12, ...}
      ],
      bids: [
        {id: 811, price: 3600, volume: 1.23, ...},
        {id: 80, price: 3550, volume: 1.11, ...}
      ]
    }
  */
 // pretty printing to console
 await market.consoleAsks();
 /*
 prints by default
┌─────────┬─────┬──────────────────────────────────────────────┬────────────────────┬────────────────────────┐
│ (index) │ id  │                    maker                     │       volume       │         price          │
├─────────┼─────┼──────────────────────────────────────────────┼────────────────────┼────────────────────────┤
│    0    │ 63  │ '0xcBb37575320FF499E9F69d0090b6944bc0aD7585' │        1000        │          1.01          │
│    1    │ 82  │ '0x3073A02460D7BE1A1C9afC60A059Ad8d788A4502' │ 6.661453068436484  │ 1.01007136594287569481 │
│    2    │ 152 │ '0x3073A02460D7BE1A1C9afC60A059Ad8d788A4502' │ 2.5010075605785964 │ 1.01008930953234142236 │
│    3    │ 123 │ '0x3073A02460D7BE1A1C9afC60A059Ad8d788A4502' │ 8.931944047363888  │ 1.01028129510766635908 │
│    4    │ 140 │ '0x3073A02460D7BE1A1C9afC60A059Ad8d788A4502' │ 3.6346162334836647 │ 1.01073119251408598466 │
└─────────┴─────┴──────────────────────────────────────────────┴────────────────────┴────────────────────────┘
 */
// Apply filter using
const filter = ["id", "wants", "gives", "gasprice", "maker"];
await market.consoleAsks(filter);

// Subscribe to orderbook
market.subscribe((event) => {
  /* `event` is an offer write, failure, success, or cancel */
  console.log(market.book());
}
```

## Buying and selling

```js
// Buy ETH with USDC (taker needs to approve USDC for mangrove transfer)
await market.quote.approveMangrove();
const { takerGot, takerGave, bounty } = await market.buy({
  volume: 2.1,
  price: 3700,
});
// Sell ETH for USDC (taker needs to approve WETH for mangrove transfer)
await market.base.approveMangrove();
const { takerGot2, takerGave2, bounty2 } = await market.sell({
  volume: 1.1,
  price: 3750,
});
```

# Using the API as a liquidity provider

## Connect to a deployed offer logic (that should match the [`IOfferLogic.sol`](https://github.com/mangrovedao/mangrove/blob/master/packages/mangrove-solidity/contracts/strategies/interfaces/IOfferLogic.sol) interface)

```js
const mgv = await Mangrove.connect("maticmum"); // Mumbai testnet
// get an `OfferLogic` object connected to a deployed offer logic (not an async function)
const logic = mgv.offerLogic(logicAddress);

// approve mangrove for transfers from the logic
logic.approveMangrove("WETH", 10000);
logic.approveMangrove("USDC", 1000000000000000);

// read current allowance
const allowance = await logic.mangroveAllowance("USDC");
// which is equivalent to the more generic call
const allowance2 = await mgv
  .token("USDC")
  .allowance({ owner: logic.address, spender: mgv.contract.address });

// fund Mangrove with 0.1 ethers so that offer logic contract can post offers (bot must have ethers)
await logic.fundMangrove(0.1);
// equivalent to
await logic.mgv.fundMangrove(0.1, logic.address);

// check current balance of offer logic at Mangrove
let balance = await logic.balanceOnMangrove();
// which is equivalent to the more generic call
balance = await mgv.balanceOf(logic.address);

// withdraw offer logic's balance from Mangrove to the signer's address
await logic.withdrawFromMangrove(0.01);
```

## Become a liquidity provider on a market

### Connect an EOA to a market

To post direct offers on a market (via signer's EOA), on gets a `LiquidityProvider` object from the API by connecting it to a `market`:

```js
const market = await mgv.market({ base: "ETH", quote: "USDC" });
// get a liquidity provider using signer's account for posting offers
let liquidity_provider = await mgv.liquidityProvider(market);
//or one is not connected to a market already:
liquidity_provider = await mgv.liquidityProvider({
  base: "ETH",
  quote: "USDC",
});
```

### Connect an onchain offer logic to a market

To post an offer via an onchain logic, one uses the `OfferLogic` object to connect to a market:

```js
const logic = mgv.offerLogic(logicAddress);
// get a liquidity provider using an onchain offer logic for posting offers
const liquidity_provider = logic.liquidityProvider({
  base: "ETH",
  quote: "USDC",
});
```

## Send bids and asks to Mangrove

```js
// post a new offer giving weth against usdc
// you can give gives/wants or price/volume
// id:number is the new offer id
// event:ethers.Event is the ethers.js event that created the offer
const { id: askId, event } = await liquidity_provider.newAsk({
  wants: 3500,
  gives: 1,
});

// post a new offer giving usdc against weth
const { id: bidId, event_ } = await liquidity_provider.newBid({
  price: 3400,
  volume: 2,
});

const asks = await liquidity_provider.asks();
const bids = await liquidity_provider.bids();

// Update an existing ask.
// You can update gives/wants or price/volume. Other parameters will not change.

const promise = liquidity_provider.updateAsk(askId, { wants: 3600, gives: 1 });
promise.then((event) => console.log("offer updated", event));

// Cancel an existing bid.
await liquidity_provider.retractBid(bidId);
```

# More Code Examples

See the docblock comments above each function definition or the official [mangrove.js Documentation](https://jsdocs.mangrove.exchange/).

# Instance Creation (Ethereum provider and signer)

See `examples` directory for instance creation examples.

Mangrove SDK initialization requires an Ethereum provider and an Ethereum signer.
They can be provided and configured in various ways, some of which are described below.

The following are valid Ethereum providers for initialization of the SDK.

```js
mgv = await Mangrove.connect(window.ethereum); // web browser

mgv = await Mangrove.connect('http://127.0.0.1:8545'); // HTTP provider

mgv = await Mangrove.connect('rinkeby'); // Uses Ethers.js fallback (for testing only)

// Init with private key (server side)
/* Note that if you provide BOTH provider and signer info,
   any connection info on the signer will be ignored, and any credentials on the provider will be ignored. */
mgv = await Mangrove.connect({
  provider: 'https://mainnet.infura.io/v3/_your_project_id_',
  privateKey: '0x_your_private_key_', // preferably with environment variable
});

// Init with a signer and a provider,
mgv = await Mangrove.connect({
  provider: 'https://mainnet.infura.io/v3/_your_project_id_',
  signer: await new ethers.Wallet(...)
});

// Init with HD mnemonic (server side)
mgv = await Mangrove.connect({
  provider: 'mainnet',
  mnemonic: 'clutch captain shoe...', // preferably with environment variable
});

// Init with a keystore file (json wallet)
mgv = await Mangrove.connect({
  provider: 'https://mainnet.infura.io/v3/_your_project_id_',
  jsonWallet: {
    path: 'path/to/UTC--created_date_time--address',
    password: 'wallet_password' // preferably with environment variable
  }
});

// Init with a custom ethers.js provider, for example a WebSocketProvider (server side)
provider = new ethers.providers.WebSocketProvider('wss://polygon-mumbai.g.alchemy.com/v2/_your_project_id_');
signer = new ethers.Wallet('0x_your_private_key_', provider);
mgv = await Mangrove.connect({signer: signer});

// Init with a EIP-1193 provider object (server side)
provider = new Web3.providers.WebsocketProvider('wss://polygon-mumbai.g.alchemy.com/v2/_your_project_id_');
mgv = await Mangrove.connect({
  provider: provider,
  privateKey: '0x_your_private_key_'
});
```

Here is the type of the argument to connect: `string | CreateSignerOption`, where a string indicates a URL, and:

```typescript
/* privateKey, mnemonic, signer, jsonWallet *will override*
   any credentials stored in provider object */
export interface CreateSignerOptions {
  // object or URL
  provider?: Provider | string;
  // optional in addition to provider object: gets signer number `signerIndex` of the provider
  signerIndex?: number;
  // raw privkey without 0x prefix
  privateKey?: string;
  // BIP39 mnemonic
  mnemonic?: string;
  // optional in addition to mnemonic: BIP44 path
  path?: string;
  // signer object
  signer?: any;
  // json wallet access information
  jsonWallet?: JsonWalletOptions;
  // if constructor finds no signer, it will throw unless this option is set to true.
  forceReadOnly?: boolean;
}

interface JsonWalletOptions {
  // local path to json wallet file
  path: string;
  // json wallet password
  password: string;
}
```

## Constants and Contract Addresses

Names of contracts, their addresses and token decimals can be found in `/src/constants.ts`. ABIs and typechain-generated types are in `types/typechain/`. Addresses, for all networks, can be easily fetched using the `getAddress` function, combined with contract name constants.

```js
cUsdtAddress = Mangrove.getAddress("USDC");
// Mainnet USDC address. Second parameter can be a network like 'rinkeby'.
```

## Numbers

Numbers returned by functions are either plain js numbers or `big.js` instances. Some functions with names ending in `Raw` may return ether.js's BigNumbers.

As input, numbers can be as plain js numbers, `big.js` instances, but also strings.

The precision used when dividing is 20 decimal places.

## Transaction Options

TODO include transaction options (see here)[https://github.com/compound-finance/compound-js#transaction-options]

## Package configuration

mangrove.js uses the [node-config](https://github.com/lorenwest/node-config) package for configuration.

It allows apps who requires `mangrove.js` to override default package configuration, by setting configuration in `MangroveJs` namespace.

Example of app configuration (`config/default.js`):

```javascript
var config = {
  ...

  MangroveJs: {
    logLevel: "info",
    ...
  }
};
module.exports = config;
```

## Logging

Console logging is enabled by default.

Logging can be configured with the following directives (see [Package
configuration](#package-configuration)).

- `logLevel`: set logging level;
- `logFile`: enable file logging.

## Tests

Tests are available in `./test/integration/*.integration.test.js`. Methods are tested using a spawned [anvil](https://book.getfoundry.sh/reference/anvil/) process. For free archive node access, get a provider URL from [Alchemy](http://alchemy.com/).

```bash
## Run all tests
yarn test

## Run a single test (Mocha JS grep option)
yarn test -- -g 'subscribes'
```

### Test configuration and root hooks

Tests are based on [Mocha](https://mochajs.org/). Mocha configuration can be found in `./test/mocha/config`.

The integration tests use the Root Hooks provided by `src/util/mochaHooks.ts`, which spawn an anvil process with Mangrove deployed and add information to the `server` and `accounts` properties of the Mocha `Context`.

## Build for Node.js & Web Browser

```shell
$ git clone ...
$ cd <Mangrove clone>
$ yarn install              # <- Only required after initial clone, afterwards 'yarn build' is sufficient
$ cd packages/mangrove.js
$ yarn build
```

The build artifacts will be placed in `./dist/nodejs` and `./dist/browser`.

## CLI: `mgv`

mangrove.js includes an experimental command line interface (CLI) for interacting with Mangrove.
You can run it using `npx`, `yarn`, or directly (if you install mangrove.js globally):

```shell
$ npx mgv
$ yarn mgv
$ mgv         # requires mangrove.js to be installed globally: npm -g install mangrove.js
mgv.js <command>

Commands:
  mgv.js parrot                  reports the current environment and warns of
                                 any discrepancies       [aliases: env-overview]
  mgv.js print <base> <quote>    print the offers on a market
  mgv.js retract <base> <quote>  retracts all offers from the given market

Options:
  --version  Show version number                                       [boolean]
  --help     Show help                                                 [boolean]

Arguments may be provided in env vars beginning with 'MGV_'. For example,
MGV_NODE_URL=https://node.url can be used instead of --nodeUrl https://node.url

You need at least one command before moving on
```
