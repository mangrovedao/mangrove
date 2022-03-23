const { ethers, network } = require("hardhat");
const { Mangrove } = require("../../../../../mangrove.js");

async function main() {
  const provider = new ethers.providers.WebSocketProvider(network.config.url);

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
  console.log(`Shutting down Mango on Mangrove (${MgvAPI.contract.address})`);

  const markets = [
    ["WETH", "USDC"],
    ["WETH", "DAI"],
    ["DAI", "USDC"],
  ];
  for (const [baseName, quoteName] of markets) {
    let MangoRaw = (
      await hre.ethers.getContract(`Mango_${baseName}_${quoteName}`)
    ).connect(tester);
    const market = await MgvAPI.market({ base: baseName, quote: quoteName });
    const Mango = await MgvAPI.offerLogic(MangoRaw.address).liquidityProvider(
      market
    );
    if ((await MangoRaw.admin()) === deployer.address) {
      const tx = await MangoRaw.connect(deployer).setAdmin(tester.address);
      await tx.wait();
    }
    const N = await MangoRaw.NSLOTS();

    const tx1 = await MangoRaw.retractOffers(
      2, // both bids and asks
      0, // from
      Math.floor(N / 3) // to
    );
    await tx1.wait();
    const tx2 = await MangoRaw.retractOffers(
      2, // both bids and asks
      Math.floor(N / 3), // from
      Math.floor((2 * N) / 3) // to
    );
    await tx2.wait();
    const tx3 = await MangoRaw.retractOffers(
      2, // both bids and asks
      Math.floor((2 * N) / 3), // from
      N // to
    );
    await tx3.wait();
    //await Promise.all([tx1, tx2, tx3]);
    console.log(`Offers retracted on (${baseName},${quoteName}) market`);
    const tx4 = await MangoRaw.pause();
    await tx4.wait();
    console.log(`Mango (${baseName},${quoteName}) is now set on reneging mode`);
    const MangoLogic = MgvAPI.offerLogic(MangoRaw.address);

    const bal = await MangoLogic.balanceOnMangrove();
    const txWithdraw = await MangoLogic.withdrawFromMangrove(bal);
    await txWithdraw.wait();
    console.log(`${bal} MATICS recovered from provisions on Mangrove`);

    const bal = await Mango.balanceOnMangrove();
    await Mango.withdrawFromMangrove(bal);
    console.log(`${bal} MATICS recovered`);
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
