/**
 * Integration tests of MarketCleaner.ts.
 */
import { afterEach, before, beforeEach, describe, it } from "mocha";
import * as chai from "chai";
const { expect } = chai;
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);

import { Mangrove, Market } from "@mangrovedao/mangrove.js";
import { mgvTestUtil } from "@mangrovedao/mangrove.js";

import { ethers } from "ethers";
import { Provider } from "@ethersproject/abstract-provider";

import { MarketCleaner } from "../../build/MarketCleaner";

let maker: mgvTestUtil.Account; // Owner of SimpleTestMaker contract
let cleaner: mgvTestUtil.Account; // Owner of cleaner EOA
let accounts: mgvTestUtil.Account[]; // All referenced accounts for easy debugging

let balancesBefore: Map<string, mgvTestUtil.Balances>; // mgvTestUtil.Account name |-> mgvTestUtil.Balances

let testProvider: Provider; // Only used to read state for assertions, not associated with an mgvTestUtil.Account
let cleanerProvider: Provider; // Tied to the cleaner bot's mgvTestUtil.Account

let mgv: Mangrove;
let market: Market;

describe("MarketCleaner integration tests", () => {
  before(async function () {
    testProvider = ethers.getDefaultProvider(this.server.url);
  });

  after(async function () {
    await mgvTestUtil.logAddresses();
  });

  beforeEach(async function () {
    mgvTestUtil.setConfig(
      await Mangrove.connect({
        privateKey: this.accounts.deployer.key,
        provider: this.server.url,
      }),
      this.accounts
    );
    maker = await mgvTestUtil.getAccount(mgvTestUtil.AccountName.Maker);
    cleaner = await mgvTestUtil.getAccount(mgvTestUtil.AccountName.Cleaner);

    accounts = [maker, cleaner];

    mgv = await Mangrove.connect({
      //provider: this.test?.parent?.parent?.ctx.providerUrl,
      signer: cleaner.signer,
    });
    market = await mgv.market({ base: "TokenA", quote: "TokenB" });

    cleanerProvider = mgv._provider;

    // Turn up the Mangrove gasprice to increase the bounty
    await mgvTestUtil.setMgvGasPrice(50);

    balancesBefore = await mgvTestUtil.getBalances(accounts, testProvider);
    mgvTestUtil.initPollOfTransactionTracking(mgv._provider);
  });

  afterEach(async function () {
    mgvTestUtil.stopPollOfTransactionTracking();
    market.disconnect();
    mgv.disconnect();

    const balancesAfter = await mgvTestUtil.getBalances(accounts, testProvider);
    mgvTestUtil.logBalances(accounts, balancesBefore, balancesAfter);
  });

  mgvTestUtil.bidsAsks.forEach((ba) => {
    it(`should clean offer failing to trade 0 wants on the '${ba}' offer list`, async function () {
      // Arrange
      await mgvTestUtil.postNewRevertingOffer(market, ba, maker);
      await mgvTestUtil.eventsForLastTxHaveBeenGenerated;
      await market.awaitCurrentProcessing();

      const marketCleaner = new MarketCleaner(market, cleanerProvider);

      // Act
      await marketCleaner.clean();

      // Assert
      return Promise.all([
        expect(market.requestBook()).to.eventually.have.property(ba).which.is
          .empty,
        expect(testProvider.getBalance(cleaner.address)).to.eventually.satisfy(
          (balanceAfter: ethers.BigNumber) =>
            balanceAfter.gt(balancesBefore.get(cleaner.name)?.ether || -1)
        ),
      ]);
    });

    it(`should not clean offer suceeding to trade 0 wants on the '${ba}' offer list`, async function () {
      // Arrange
      await mgvTestUtil.postNewSucceedingOffer(market, ba, maker);
      await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

      const marketCleaner = new MarketCleaner(market, cleanerProvider);

      // Act
      await marketCleaner.clean();

      // Assert
      return Promise.all([
        expect(
          market.requestBook(),
          "there should be exactly one element in `ba`"
        )
          .to.eventually.have.property(ba)
          .which.has.lengthOf(1),
        expect(
          testProvider.getBalance(cleaner.address),
          "the balance of the cleaner changed, it should not"
        ).to.eventually.satisfy((balanceAfter: ethers.BigNumber) =>
          balanceAfter.eq(balancesBefore.get(cleaner.name)?.ether || -1)
        ),
      ]);
    });
  });
});
