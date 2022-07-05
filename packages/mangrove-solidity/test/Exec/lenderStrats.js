const lc = require("lib/libcommon.js");
const { ethers } = require("hardhat");
const { stopListeners } = require("../../lib/libcommon");

async function execLenderStrat(
  makerContract,
  mgv,
  reader,
  lenderName,
  players
) {
  const zero = ethers.BigNumber.from(0);

  await lc.logLenderStatus(
    makerContract,
    lenderName,
    ["DAI", "WETH"],
    players.maker.address
  );

  // // posting new offer on Mangrove via the MakerContract `newOffer` external function
  let offerId = await lc.newOffer(
    mgv,
    makerContract.connect(players.maker.signer),
    "DAI", // outbound
    "WETH", // inbound
    lc.parseToken("0.5", await lc.getDecimals("WETH")), // required WETH
    lc.parseToken("1000.0", await lc.getDecimals("DAI")) // promised DAI
  );

  let [takerGot, takerGave] = await lc.snipeSuccess(
    mgv.connect(players.taker.signer),
    reader,
    "DAI", // maker outbound
    "WETH", // maker inbound
    offerId,
    lc.parseToken("800.0", await lc.getDecimals("DAI")), // taker wants 800 DAI
    lc.parseToken("0.5", await lc.getDecimals("WETH")) // taker is ready to give up-to 0.5 WETH
  );

  lc.assertEqualBN(
    takerGot,
    lc.netOf(lc.parseToken("800.0", await lc.getDecimals("DAI")), fee),
    "Incorrect received amount"
  );

  lc.assertEqualBN(
    takerGave,
    lc.parseToken("0.4", await lc.getDecimals("WETH")),
    "Incorrect given amount"
  );

  await lc.logLenderStatus(
    makerContract,
    lenderName,
    ["DAI", "WETH"],
    players.maker.address
  );

  await lc.expectAmountOnLender(players.maker.address, lenderName, [
    ["DAI", lc.parseToken("200", await lc.getDecimals("DAI")), zero, 4],
    ["WETH", lc.parseToken("0.4", await lc.getDecimals("WETH")), zero, 8],
  ]);
}

async function execTraderStrat(makerContract, router, mgv, reader, lenderName) {
  const zero = ethers.BigNumber.from(0);

  await lc.logLenderStatus(
    router,
    lenderName,
    ["DAI", "WETH"],
    router.address,
    makerContract.address
  );

  // posting new offer on Mangrove via the MakerContract
  let offerId = await lc.newOffer(
    mgv,
    makerContract,
    "DAI", //base
    "WETH", //quote
    lc.parseToken("0.15", await lc.getDecimals("WETH")), // required WETH
    lc.parseToken("300.0", await lc.getDecimals("DAI")) // promised DAI (will need to borrow)
  );

  let [takerGot, takerGave, bounty] = await lc.snipeSuccess(
    mgv,
    reader,
    "DAI", // maker base
    "WETH", // maker quote
    offerId,
    lc.parseToken("300", await lc.getDecimals("DAI")),
    lc.parseToken("0.15", await lc.getDecimals("WETH"))
  );
  lc.assertEqualBN(
    takerGot,
    lc.netOf(lc.parseToken("300.0", await lc.getDecimals("DAI")), fee),
    "Incorrect received amount"
  );
  lc.assertEqualBN(
    takerGave,
    lc.parseToken("0.15", await lc.getDecimals("WETH")),
    "Incorrect given amount"
  );
  lc.assertEqualBN(bounty, 0, "Snipe should not fail on the maker side");

  await lc.logLenderStatus(
    router,
    lenderName,
    ["DAI", "WETH"],
    router.address,
    makerContract.address
  );
  await lc.expectAmountOnLender(router.address, lenderName, [
    ["DAI", lc.parseToken("700", await lc.getDecimals("DAI")), zero, 4],
    ["WETH", takerGave, zero, 8],
  ]);

  offerId = await lc.newOffer(
    mgv,
    makerContract,
    "WETH", // base
    "DAI", //quote
    lc.parseToken("380.0", await lc.getDecimals("DAI")), // wants DAI
    lc.parseToken("0.2", await lc.getDecimals("WETH")) // promised WETH
  );

  [takerGot, takerGave] = await lc.snipeSuccess(
    mgv,
    reader,
    "WETH",
    "DAI",
    offerId,
    lc.parseToken("0.2", await lc.getDecimals("WETH")), // wanted WETH
    lc.parseToken("380.0", await lc.getDecimals("DAI")) // giving DAI
  );

  lc.assertEqualBN(
    takerGot,
    lc.netOf(lc.parseToken("0.2", await lc.getDecimals("WETH")), fee),
    "Incorrect received amount"
  );
  lc.assertEqualBN(
    takerGave,
    lc.parseToken("380", await lc.getDecimals("DAI")),
    "Incorrect given amount"
  );

  await lc.expectAmountOnLender(router.address, lenderName, [
    // dai_on_lender = (1080 * CF_DAI * price_DAI - 0.05 * price_ETH)/price_DAI
    ["WETH", zero, lc.parseToken("0.05", await lc.getDecimals("WETH")), 9],
  ]);
  await lc.logLenderStatus(
    router,
    lenderName,
    ["DAI", "WETH"],
    router.address,
    makerContract.address
  );

  offerId = await lc.newOffer(
    mgv,
    makerContract,
    "DAI", //base
    "WETH", //quote
    lc.parseToken("0.63", await lc.getDecimals("WETH")), // wants ETH
    lc.parseToken("1500", await lc.getDecimals("DAI")) // gives DAI
  );

  [takerGot, takerGave] = await lc.snipeSuccess(
    mgv,
    reader,
    "DAI",
    "WETH",
    offerId,
    lc.parseToken("1500", await lc.getDecimals("DAI")), // wanted DAI
    lc.parseToken("0.63", await lc.getDecimals("WETH")) // giving WETH
  );
  lc.assertEqualBN(
    takerGot,
    lc.netOf(lc.parseToken("1500", await lc.getDecimals("DAI")), fee),
    "Incorrect received amount"
  );
  lc.assertEqualBN(
    takerGave,
    lc.parseToken("0.63", await lc.getDecimals("WETH")),
    "Incorrect given amount"
  );
  await lc.logLenderStatus(
    router,
    lenderName,
    ["DAI", "WETH"],
    router.address,
    makerContract.address
  );
  // expecting ~ 0.63 (received) - 0.05 (debt) as aWeth balance
  await lc.expectAmountOnLender(router.address, lenderName, [
    ["WETH", lc.parseToken("0.58", await lc.getDecimals("WETH")), zero, 9],
  ]);
  //TODO check borrowing DAIs and not borrowing WETHs anymore
}

exports.execLenderStrat = execLenderStrat;
exports.execTraderStrat = execTraderStrat;
