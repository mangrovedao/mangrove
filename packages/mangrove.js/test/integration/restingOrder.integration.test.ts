// Integration tests for SimpleMaker.ts
import { afterEach, beforeEach, describe, it } from "mocha";
const chalk = require("chalk");

import { ethers, utils } from "ethers";
const hre = require("hardhat");
//const { ethers } = require("hardhat");

import assert from "assert";
import { Mangrove, LiquidityProvider, Market } from "../../src";

import { Big } from "big.js";

//pretty-print when using console.log
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] = function () {
  return `<Big>${this.toString()}`; // previously just Big.prototype.toString;
};

describe("RestingOrder", () => {
  let mgv: Mangrove;

  afterEach(async () => {
    mgv.disconnect();
  });

  describe("RestingOrder connectivity", () => {
    it("deploys and connects", async () => {
      mgv = await Mangrove.connect({
        provider: "http://localhost:8546",
      });
      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 250;

      // interpreting mangroveOrder as a multi user maker contract
      const logic = mgv.offerLogic(mgv.orderContract.address, true);
      const lp = await logic.liquidityProvider({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });
      //check that contract responds
      const gasreq = await lp.logic.contract.OFR_GASREQ();
      assert(gasreq.gt(0), "Cannot talk to resting order contract");
    });
  });

  describe("Resting order integration tests suite", () => {
    let orderContractAsLP: LiquidityProvider = null;
    /* Make sure tx has been mined so we can read the result off the chain */
    const w = async (r) => (await r).wait(1);

    beforeEach(async function () {
      //set mgv object
      mgv = await Mangrove.connect({
        provider: "http://localhost:8546",
      });

      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 250;
      const logic = mgv.offerLogic(mgv.orderContract.address, true);
      const market = await mgv.market({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });
      orderContractAsLP = await logic.liquidityProvider(market);
      await w(orderContractAsLP.approveMangrove("TokenA"));
      await w(orderContractAsLP.approveMangrove("TokenB"));

      // minting As and Bs for test runner
      const me = await mgv._signer.getAddress();
      await w(
        mgv.token("TokenA").contract.mint(me, utils.parseUnits("100", 18))
      );
      // depositing tokens on the strat (approve and deposit)
      await w(mgv.token("TokenA").approve(orderContractAsLP.logic.address));
      await w(orderContractAsLP.logic.depositToken("TokenA", 50));

      await w(
        mgv.token("TokenB").contract.mint(me, utils.parseUnits("100", 18))
      );

      // `me` proposes asks on Mangrove so should approve base
      await w(mgv.token("TokenA").approveMangrove());

      const provision = await orderContractAsLP.computeAskProvision();
      // fills Asks semi book
      await orderContractAsLP.newAsk({
        wants: 10, //tokenB
        gives: 10, //tokenA
        fund: provision,
      });
      await orderContractAsLP.newAsk({
        wants: 10,
        gives: 9,
        fund: provision,
      });
      await orderContractAsLP.newAsk({
        wants: 10,
        gives: 8,
        fund: provision,
      });
    });

    it("simple resting order", async () => {
      const provision = await orderContractAsLP.computeBidProvision();
      // `me` buying base so should approve orderContract for quote
      await w(mgv.token("TokenB").approve(orderContractAsLP.logic.address));

      const orderResult: Market.OrderResult =
        await orderContractAsLP.market.buy({
          wants: 20, // tokenA
          gives: 20, // tokenB
          restingOrder: { provision: provision },
        });
      assert(orderResult.got.eq(10), "Taker received an incorrect amount");
      assert(orderResult.gave.eq(10), "Taker gave an incorrect amount");
      assert(orderResult.offerId > 0, "Resting order was not posted");
      assert(
        orderResult.partialFill,
        "Order should have been partially filled"
      );
      assert(orderResult.penalty.eq(0), "No offer should have failed");
    });

    it("resting order with deadline", async () => {
      // dirty trick to advance blocks as automine will do so every time a signed tx is sent
      const advanceBlocks = async (blocks: number) => {
        for (let i = 0; i < blocks; i++) {
          await orderContractAsLP.approveMangrove("TokenA");
        }
      };
      const provision = await orderContractAsLP.computeBidProvision();
      const market: Market = orderContractAsLP.market;
      // `me` buying base so should approve orderContract for quote
      await w(mgv.token("TokenB").approve(orderContractAsLP.logic.address));

      const orderResult: Market.OrderResult = await market.buy({
        wants: 20, // tokenA
        gives: 20, // tokenB
        restingOrder: { provision: provision, blocksToLiveForRestingOrder: 5 },
      });

      assert(orderResult.offerId > 0, "Resting order was not posted");
      const ttl = await mgv.orderContract.expiring(
        mgv.token("TokenB").address,
        mgv.token("TokenA").address,
        orderResult.offerId
      );

      // taking resting offer

      await w(mgv.token("TokenB").approveMangrove());
      await w(mgv.token("TokenA").approveMangrove());

      const result = await market.sell({ wants: 5, gives: 5 });
      assert(result.got.eq(5), "Sell order went wrong");
      assert(
        await orderContractAsLP.market.isLive("bids", orderResult.offerId),
        "Residual should still be in the book"
      );
      await advanceBlocks(6);

      assert(
        ttl.lt(await mgv._provider.getBlockNumber()),
        "Block number is incorrect"
      );
      const result_ = await market.sell({ wants: 5, gives: 5 });
      assert(result_.penalty.gt(0), "Order should have reneged");
    });
  });
});
