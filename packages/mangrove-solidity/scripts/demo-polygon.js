// this script assumes dotenv package is installed `(npm install dotenv --save)`
// and you have MUMBAI_NODE_URL and MUMBAI_TESTER_PRIVATE_KEY in your .env file
util.inspect.replDefaults.depth = 0;
const env = require("dotenv").config();
const { Mangrove } = require("../git/mangrove/packages/mangrove.js");
const ethers = require("ethers");

// BUG: needs to override gasPrice for all signed tx
// otherwise ethers.js gives 1.5 gwei which is way too low
const overrides = { gasPrice: ethers.utils.parseUnits("60", "gwei") };

const provider = new ethers.providers.JsonRpcProvider(
  env.parsed.MUMBAI_NODE_URL
);

let wallet = new ethers.Wallet(env.parsed.MUMBAI_TESTER_PRIVATE_KEY, provider);

//connecting the API to Mangrove
let mgv = await Mangrove.connect({ signer: wallet });

//connecting mgv to a market
let market = await mgv.market({ base: "DAI", quote: "USDC" });

// check its live
market.consoleAsks(["id", "price", "volume"]);

/// connecting to offerProxy's onchain logic
/// logic has already approved Mangrove for DAI, WETH transfer
/// it has also already approved router to manage its funds
const logic = mgv.offerLogic("OfferProxy");
const maker = await logic.liquidityProvider(market);

// allowing logic to pull my overlying to finance my offers
tx = await logic.approveToken("aDAI", overrides);
await tx.wait();

tx = await logic.approveToken("aUSDC", overrides);
await tx.wait();

// checking needed provision
// prov = await maker.computeAskProvision();
// BUG: this currenlty returns zero because API is not up to date with Multi Maker way of funding offers

router = await logic.router();
aaveMod = logic.aaveModule(router.address);

await aaveMod.logStatus(["WETH", "DAI", "USDC"]);

// allowing router to borrow DAI on behalf of signer's address
tx = await aaveMod.approveDelegation("DAI", router.address, overrides);
await tx.wait();

const { id: id } = await maker.newAsk(
  {
    volume: 5000,
    price: 1.01,
    fund: 0.1,
  },
  overrides
);
// BUG: this results in a throw of the API when mangrove is not active on this market
// Uncaught { revert: false, exception: 'tx mined but filter never returned true' }

tx = await mgv.approveMangrove("USDC", overrides); // approve payment ERC
await tx.wait();
// buying DAIs with USDC
const buyResult = await market.buy({ volume: 5000, price: 1.03 }, overrides);

await aaveMod.logStatus(["WETH", "DAI", "USDC"]);

const { id: id_ } = await maker.newBid(
  {
    volume: 5000,
    price: 0.99,
    fund: 0.1,
  },
  overrides
);

tx = await mgv.approveMangrove("DAI", overrides); // approve payment ERC
await tx.wait();
// buying DAIs with USDC
const sellResult = await market.sell({ volume: 5000, price: 0.9 }, overrides);

await aaveMod.logStatus(["WETH", "DAI", "USDC"]);
