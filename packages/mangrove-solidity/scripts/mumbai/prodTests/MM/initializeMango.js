const { ethers, network } = require("hardhat");
const { Mangrove } = require("../../../../../mangrove.js");

async function main() {
  const provider = ethers.getDefaultProvider(network.config.url);

  if (!process.env["MUMBAI_DEPLOYER_PRIVATE_KEY"]) {
    console.error("No deployer account defined");
  }
  const deployer = new ethers.Wallet(
    process.env["MUMBAI_DEPLOYER_PRIVATE_KEY"],
    provider
  );
  if (!process.env["MUMBAI_TESTER_PRIVATE_KEY"]) {
    console.error("No tester account defined");
  }
  const tester = new ethers.Wallet(
    process.env["MUMBAI_TESTER_PRIVATE_KEY"],
    provider
  );

  const MgvAPI = await Mangrove.connect({
    signer: tester,
  });

  const markets = [
    ["WETH", "USDC"],
    ["WETH", "DAI"],
    ["DAI", "USDC"],
  ];
  for (const [baseName, quoteName] of markets) {
    let tx = null;
    let default_base_amount = baseName === "WETH" ? 0.25 : 1000;
    let default_quote_amount = quoteName === "WETH" ? 0.25 : 1000;
    // NSLOTS/2 offers giving base (~1000 USD each)
    // NSLOTS/2 offers giving quote (~1000 USD)

    let MangoRaw = (
      await hre.ethers.getContract(`Mango_${baseName}_${quoteName}`)
    ).connect(deployer);

    if ((await MangoRaw.admin()) === deployer.address) {
      tx = await MangoRaw.setAdmin(tester.address);
      await tx.wait();
    }

    MangoRaw = MangoRaw.connect(tester);

    let [pendingBase, pendingQuote] = await MangoRaw.get_pending();
    if (pendingBase.gt(0) || pendingQuote.gt(0)) {
      console.log(
        `* Current deployment of Mango has pending liquidity, resetting.`
      );
      tx = await MangoRaw.reset_pending();
    }

    if (!((await MangoRaw.get_treasury(true)) === tester.address)) {
      console.log(`* Set ${baseName} treasury to tester wallet`);
      tx = await MangoRaw.set_treasury(true, tester.address);
      await tx.wait();
    }
    if (!((await MangoRaw.get_treasury(false)) === tester.address)) {
      console.log(`* Set ${quoteName} treasury to tester wallet`);
      tx = await MangoRaw.set_treasury(false, tester.address);
      await tx.wait();
    }

    const NSLOTS = await MangoRaw.NSLOTS();
    const market = await MgvAPI.market({ base: baseName, quote: quoteName });
    const Mango = await MgvAPI.offerLogic(MangoRaw.address).liquidityProvider(
      market
    );
    const provBid = await Mango.computeBidProvision();
    console.log(
      `Actual provision needed for a Bid on (${baseName},${quoteName}) Market is ${provBid}`
    );
    const provAsk = await Mango.computeAskProvision();
    console.log(
      `Actual provision needed for an Ask on (${baseName},${quoteName}) Market is ${provAsk}`
    );
    const totalFund = provAsk.add(provBid).mul(NSLOTS);

    if (totalFund.gt(0)) {
      console.log(`* Funding mangrove (${totalFund} MATIC for Mango)`);
      tx = await Mango.fundMangrove(totalFund);
      await tx.wait();
    }

    if ((await MgvAPI.token(baseName).allowance()).eq(0)) {
      console.log(
        `* Approving mangrove as spender for ${baseName} and ${quoteName} transfer from Mango`
      );
      tx = await Mango.approveMangrove(baseName);
      await tx.wait();
    }

    tx = await Mango.approveMangrove(quoteName);
    await tx.wait();

    console.log(
      `* Approve Mango as spender for ${baseName} and ${quoteName} token transfer from tester wallet`
    );

    tx = await MgvAPI.token(baseName).approve(MangoRaw.address);
    await tx.wait();
    tx = await MgvAPI.token(quoteName).approve(MangoRaw.address);
    await tx.wait();

    tx = await MangoRaw.restart();
    await tx.wait();

    console.log(
      `* Posting Mango offers on (${baseName},${quoteName}) market (current price shift ${(
        await MangoRaw.get_shift()
      ).toNumber()})`
    );

    const offers_per_slice = 10;
    const slices = NSLOTS / offers_per_slice; // slices of 10 offers

    let pivotIds = new Array(NSLOTS);
    let amounts = new Array(NSLOTS);

    pivotIds = pivotIds.fill(0, 0);
    // init amount is expressed in `makerGives` amount (i.e base for bids and quote for asks)
    amounts.fill(default_base_amount, 0, NSLOTS / 2);
    amounts.fill(default_quote_amount, NSLOTS / 2, NSLOTS);

    for (let i = 0; i < slices; i++) {
      const receipt = await MangoRaw.initialize(
        NSLOTS / 2 - 1,
        offers_per_slice * i, // from
        offers_per_slice * (i + 1), // to
        [pivotIds, pivotIds],
        amounts
      );
      console.log(
        `Slice initialized (${(await receipt.wait()).gasUsed} gas used)`
      );
    }
    console.log(`Done! (gas used ${receipt.gasUsed.toString()})`);

    [pendingBase, pendingQuote] = await MangoRaw.get_pending();
    if (pendingBase.gt(0) || pendingQuote.gt(0)) {
      throw Error(
        `Init error, failed to initialize (${MgvAPI.token(baseName).fromUnits(
          pendingBase
        )} pending base,${MgvAPI.token(quoteName).fromUnits(
          pendingQuote
        )} pending quotes)`
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
