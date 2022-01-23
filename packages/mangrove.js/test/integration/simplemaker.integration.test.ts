// Integration tests for SimpleMaker.ts
import { afterEach, beforeEach, describe, it } from "mocha";

import { BigNumber } from "ethers";

import assert from "assert";
import { Mangrove, OfferLogic, LiquidityProvider } from "../../src";

import { Big } from "big.js";

//pretty-print when using console.log
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] = function () {
  return `<Big>${this.toString()}`; // previously just Big.prototype.toString;
};

describe("SimpleMaker", () => {
  let mgv: Mangrove;

  afterEach(async () => {
    mgv.disconnect();
  });

  describe("SimpleMaker connectivity", () => {
    it("deploys and connects", async () => {
      mgv = await Mangrove.connect({
        provider: "http://localhost:8546",
      });
      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 250;
      const mkr_address = await OfferLogic.deploy(mgv, "SimpleMaker");
      const logic = mgv.offerLogic(mkr_address);
      const lp = await logic.liquidityProvider({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });
      // const mkr = await mgv.makerConnect({
      //   address: mkr_address,
      //   base: "TokenA",
      //   quote: "TokenB",
      // });
      //check that contract responds
      await lp.logic.contract.OFR_GASREQ();
    });
  });

  describe("SimpleMaker integration tests suite", () => {
    let onchain_lp: LiquidityProvider;
    let eoa_lp: LiquidityProvider;

    beforeEach(async function () {
      //set mgv object
      mgv = await Mangrove.connect({
        provider: "http://localhost:8546",
      });

      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 250;

      const mkr_address = await OfferLogic.deploy(mgv, "SimpleMaker");
      const logic = mgv.offerLogic(mkr_address);
      const market = await mgv.market({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });
      onchain_lp = await logic.liquidityProvider(market);
      eoa_lp = await mgv.liquidityProvider(market);
    });

    /* Make sure tx has been mined so we can read the result off the chain */
    const w = async (r) => (await r).wait(1);

    describe("Before setup", () => {
      it("checks allowance for onchain logic", async () => {
        let allowanceForLogic /*:Big*/ = await onchain_lp.mangroveAllowance(
          "TokenB"
        );
        assert.strictEqual(
          allowanceForLogic.toNumber(),
          0,
          "allowance should be 0"
        );

        const overridesTest = { gasLimit: 100000 };
        // test specified approve amount
        await w(onchain_lp.approveMangrove("TokenB", 10 ** 9, overridesTest));
        allowanceForLogic /*:Big*/ = await onchain_lp.mangroveAllowance(
          "TokenB"
        );
        assert.strictEqual(
          allowanceForLogic.toNumber(),
          10 ** 9,
          "allowance should be 1 billion"
        );
        // test default approve amount
        await w(onchain_lp.approveMangrove("TokenB"));
        allowanceForLogic /*:Big*/ = await onchain_lp.mangroveAllowance(
          "TokenB"
        );
        assert.strictEqual(
          mgv.toUnits(allowanceForLogic, 18).toString(),
          BigNumber.from(2).pow(256).sub(1).toString(),
          "allowance should be 2^256-1"
        );
      });

      it("checks allowance for AOE provider", async () => {
        let allowanceForEOA = await eoa_lp.mangroveAllowance("TokenB");
        assert.strictEqual(
          allowanceForEOA.toNumber(),
          0,
          "allowance should be 0"
        );

        const overridesTest = { gasLimit: 100000 };
        // test specified approve amount
        await w(eoa_lp.approveMangrove("TokenB", 10 ** 9, overridesTest));
        allowanceForEOA /*:Big*/ = await eoa_lp.mangroveAllowance("TokenB");
        assert.strictEqual(
          allowanceForEOA.toNumber(),
          10 ** 9,
          "allowance should be 1 billion"
        );
        // test default approve amount
        await w(eoa_lp.approveMangrove("TokenB"));
        allowanceForEOA /*:Big*/ = await eoa_lp.mangroveAllowance("TokenB");
        assert.strictEqual(
          mgv.toUnits(allowanceForEOA, 18).toString(),
          BigNumber.from(2).pow(256).sub(1).toString(),
          "allowance should be 2^256-1"
        );
      });

      it("checks provision for EOA provider", async () => {
        let balance = await eoa_lp.balanceOnMangrove();
        assert.strictEqual(balance.toNumber(), 0, "balance should be 0");
        await w(eoa_lp.fundMangrove(2));
        balance = await eoa_lp.balanceOnMangrove();
        assert.strictEqual(balance.toNumber(), 2, "balance should be 2");
      });

      it("checks provision for onchain logic", async () => {
        let balance = await onchain_lp.balanceOnMangrove();
        assert.strictEqual(balance.toNumber(), 0, "balance should be 0");
        await w(onchain_lp.fundMangrove(2));
        balance = await onchain_lp.balanceOnMangrove();
        assert.strictEqual(balance.toNumber(), 2, "balance should be 2");
      });
    });

    describe("After setup", () => {
      beforeEach(async () => {
        await eoa_lp.approveMangrove("TokenB", 10 ** 9);
        //await logic.fundMangrove(10);
      });

      it("withdraws", async () => {
        const getBal = async () =>
          mgv._provider.getBalance(await mgv._signer.getAddress());
        await w(onchain_lp.fundMangrove(10));
        const oldBal = await getBal();
        const receipt = await w(onchain_lp.withdraw(10));
        const txcost = receipt.effectiveGasPrice.mul(receipt.gasUsed);
        const diff = mgv.fromUnits(
          (await getBal()).sub(oldBal).add(txcost),
          18
        );

        assert.strictEqual(diff.toNumber(), 10, "wrong balance");
      });

      it("pushes a new offer", async () => {
        const provision = await onchain_lp.computeAskProvision({});
        await onchain_lp.fundMangrove(provision);
        const { id: ofrId } = await onchain_lp.newAsk({ wants: 10, gives: 10 });
        const asks = onchain_lp.asks();
        assert.strictEqual(
          asks.length,
          1,
          "there should be one ask in the book"
        );
        assert.deepStrictEqual(asks[0].id, ofrId, "wrong offer id");
        const missingProvision = await onchain_lp.computeAskProvision({
          id: ofrId,
        });
        assert(
          missingProvision.eq(0),
          `there should be no missing provision for this offer (${missingProvision.toNumber()})`
        );
      });

      it("cancels offer", async () => {
        const provision = await onchain_lp.computeBidProvision({});
        await onchain_lp.fundMangrove(provision);
        const { id: ofrId } = await onchain_lp.newBid({
          wants: 10,
          gives: 20,
        });
        let prov_before_cancel = await onchain_lp.balanceOnMangrove();
        await onchain_lp.cancelBid(ofrId, true); // with deprovision
        const bids = onchain_lp.bids();
        assert.strictEqual(bids.length, 0, "offer should have been canceled");
        let prov_after_cancel = await onchain_lp.balanceOnMangrove();
        assert(
          prov_after_cancel.gt(prov_before_cancel),
          "Maker was not refunded"
        );
        const offerInfo = await onchain_lp.market.offerInfo("bids", ofrId);
        const config = await onchain_lp.market.config();
        console.log(offerInfo, config);
        // this second call hangs...
        await onchain_lp.cancelBid(ofrId);
        // let prov_after_cancel2 = await onchain_lp.balanceOnMangrove();
        // assert.strictEqual(prov_after_cancel2, prov_before_cancel, "Cancel twice should not provision maker");
      });

      it("updates offer", async () => {
        let provision = await onchain_lp.computeAskProvision({});
        await onchain_lp.fundMangrove(provision);
        const { id: ofrId } = await onchain_lp.newAsk({
          wants: 10,
          gives: 20,
        });
        provision = await onchain_lp.computeAskProvision({ id: ofrId });
        assert.strictEqual(
          provision.toNumber(),
          0,
          `There should be no need to reprovision`
        );
        await onchain_lp.updateAsk(ofrId, { wants: 12, gives: 10 });

        const asks = onchain_lp.asks();
        assert.strictEqual(
          asks[0].wants.toNumber(),
          12,
          "offer should have updated wants"
        );
        assert.strictEqual(
          asks[0].gives.toNumber(),
          10,
          "offer should have updated gives"
        );
      });

      it("changes gasreq", async () => {
        await onchain_lp.logic.setDefaultGasreq(50000);
        assert.strictEqual(
          50000,
          (await onchain_lp.logic.contract.OFR_GASREQ()).toNumber(),
          "Offer default gasreq not updated"
        );
      });
    });
  });
});
