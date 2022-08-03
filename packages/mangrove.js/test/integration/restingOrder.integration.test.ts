// Integration tests for SimpleMaker.ts
import { afterEach, beforeEach, describe, it } from "mocha";
import chalk from "chalk";

import { utils } from "ethers";

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

  describe("RestingOrder connectivity", function () {
    it("deploys and connects", async function () {
      mgv = await Mangrove.connect({
        provider: this.server.url,
        privateKey: this.accounts.tester.key,
      });
      //shorten polling for faster tests
      (mgv._provider as any).pollingInterval = 10;

      // interpreting mangroveOrder as a multi user maker contract
      const logic = mgv.offerLogic(mgv.orderContract.address, true);
      const lp = await logic.liquidityProvider({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });

      //check that contract responds
      const gasreq = await lp.logic?.contract.ofr_gasreq();
      assert(gasreq?.gt(0), "Cannot talk to resting order contract");
    });
  });

  describe("Resting order integration tests suite", () => {
    let orderContractAsLP: LiquidityProvider;
    let meAsLP: LiquidityProvider;
    /* Make sure tx has been mined so we can read the result off the chain */
    const w = async (r) => (await r).wait(1);

    beforeEach(async function () {
      //set mgv object

      mgv = await Mangrove.connect({
        provider: this.server.url,
        privateKey: this.accounts.deployer.key,
      });

      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 10;
      const logic = mgv.offerLogic(mgv.orderContract.address, true);
      const market = await mgv.market({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });

      orderContractAsLP = await logic.liquidityProvider(market);

      await w(orderContractAsLP.logic.activate(["TokenA", "TokenB"]));

      // minting As and Bs for test runner
      const me = await mgv._signer.getAddress();
      await w(
        mgv.token("TokenA").contract.mint(me, utils.parseUnits("100", 18))
      );
      await w(
        mgv.token("TokenB").contract.mint(me, utils.parseUnits("100", 18))
      );

      // `me` proposes asks on Mangrove so should approve base
      await w(mgv.token("TokenA").approveMangrove());
      meAsLP = await mgv.liquidityProvider(market);

      const provision = await meAsLP.computeAskProvision();
      // fills Asks semi book
      await meAsLP.newAsk({
        wants: 10, //tokenB
        gives: 10, //tokenA
        fund: provision,
      });
      await meAsLP.newAsk({
        wants: 10,
        gives: 9,
        fund: provision,
      });
      await meAsLP.newAsk({
        wants: 10,
        gives: 8,
        fund: provision,
      });
    });

    it("simple resting order", async () => {
      const provision = await orderContractAsLP.computeBidProvision();
      const router_address = await orderContractAsLP.logic?.contract.router();
      // `me` buying base via orderContract so should approve it for quote
      await w(mgv.token("TokenB").approve(router_address));
      await w(mgv.token("TokenA").approve(router_address));

      const orderResult: Market.OrderResult =
        await orderContractAsLP.market.buy({
          wants: 20, // tokenA
          gives: 20, // tokenB
          restingOrder: { provision: provision },
        });
      assert(
        orderResult.summary.got.eq(10),
        "Taker received an incorrect amount"
      );
      assert(orderResult.summary.gave.eq(10), "Taker gave an incorrect amount");
      assert(orderResult.summary.offerId > 0, "Resting order was not posted");
      assert(
        orderResult.summary.partialFill,
        "Order should have been partially filled"
      );
      assert(orderResult.summary.penalty.eq(0), "No offer should have failed");
    });

    it("resting order with deadline", async () => {
      // dirty trick to advance blocks as automine will do so every time a signed tx is sent
      const advanceBlocks = async (blocks: number) => {
        for (let i = 0; i < blocks; i++) {
          await (mgv._provider as any).send("anvil_mine", ["0x100"]);
        }
      };
      const provision = await orderContractAsLP.computeBidProvision();
      const market: Market = orderContractAsLP.market;
      // `me` buying base so should approve orderContract for quote
      const router_address = await orderContractAsLP.logic?.contract.router();
      // `me` buying base via orderContract so should approve it for quote
      await w(mgv.token("TokenB").approve(router_address));
      await w(mgv.token("TokenA").approve(router_address));

      const orderResult: Market.OrderResult = await market.buy({
        wants: 20, // tokenA
        gives: 20, // tokenB
        restingOrder: { provision: provision, blocksToLiveForRestingOrder: 5 },
      });

      assert(orderResult.summary.offerId > 0, "Resting order was not posted");
      const ttl = await mgv.orderContract.expiring(
        mgv.token("TokenB").address,
        mgv.token("TokenA").address,
        orderResult.summary.offerId
      );

      // taking resting offer

      await w(mgv.token("TokenB").approveMangrove());
      await w(mgv.token("TokenA").approveMangrove());

      const result = await market.sell({ wants: 5, gives: 5 });
      assert(result.summary.got.eq(5), "Sell order went wrong");
      assert(
        await orderContractAsLP.market.isLive(
          "bids",
          orderResult.summary.offerId
        ),
        "Residual should still be in the book"
      );
      await advanceBlocks(6);

      assert(
        ttl.lt(await mgv._provider.getBlockNumber()),
        "Block number is incorrect"
      );
      const result_ = await market.sell({ wants: 5, gives: 5 });
      assert(result_.summary.penalty.gt(0), "Order should have reneged");
    });
  });
});
