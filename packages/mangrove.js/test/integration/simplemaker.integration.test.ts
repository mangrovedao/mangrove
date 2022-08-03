// Integration tests for SimpleMaker.ts
import { afterEach, beforeEach, describe, it } from "mocha";

import { BigNumber } from "ethers";

import assert from "assert";
import { Mangrove, OfferLogic, LiquidityProvider } from "../../src";
import { approxEq } from "../util/helpers";

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
    it("deploys and connects", async function () {
      mgv = await Mangrove.connect({
        provider: this.server.url,
        privateKey: this.accounts.tester.key,
      });
      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 10;
      const mkr_address = await OfferLogic.deploy(mgv, "SimpleMaker");
      const logic = mgv.offerLogic(mkr_address, false);
      const lp = await logic.liquidityProvider({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 30 },
      });
      await lp.logic?.contract.ofr_gasreq();
    });
  });

  describe("SimpleMaker integration tests suite", () => {
    let onchain_lp: LiquidityProvider;
    let eoa_lp: LiquidityProvider;

    beforeEach(async function () {
      //set mgv object
      mgv = await Mangrove.connect({
        provider: this.server.url,
        privateKey: this.accounts.tester.key,
      });

      //shorten polling for faster tests
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      mgv._provider.pollingInterval = 10;

      const mkr_address = await OfferLogic.deploy(mgv, "SimpleMaker");
      const logic = mgv.offerLogic(mkr_address, false);
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

        // test default approve amount
        await w(onchain_lp.logic?.approveMangrove("TokenB"));
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
        await w(
          mgv
            .token("TokenB")
            .approveMangrove({ amount: 10 ** 9 }, overridesTest)
        );
        allowanceForEOA /*:Big*/ = await eoa_lp.mangroveAllowance("TokenB");
        assert.strictEqual(
          allowanceForEOA.toNumber(),
          10 ** 9,
          "allowance should be 1 billion"
        );
        // test default approve amount
        await w(mgv.token("TokenB").approveMangrove());
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
        await mgv.token("TokenB").approveMangrove();
        //await logic.fundMangrove(10);
      });

      it("withdraws", async () => {
        const getBal = async () =>
          mgv._provider.getBalance(await mgv._signer.getAddress());
        let tx = await onchain_lp.fundMangrove(10);
        await tx.wait();
        const oldBal = await getBal();
        tx = await onchain_lp.withdrawFromMangrove(10);
        const receipt = await tx.wait();
        const txcost = receipt.effectiveGasPrice.mul(receipt.gasUsed);
        const diff = mgv.fromUnits(
          (await getBal()).sub(oldBal).add(txcost),
          18
        );

        /* FIXME the effectiveGasPrice returned by anvil is incorrect, so for now we do an approx estimate. */
        const diff2 = (await getBal()).sub(oldBal).add(txcost);
        assert(approxEq(diff2, mgv.toUnits(10, 18), "0.001"), "wrong balance");
      });

      it("pushes a new offer", async () => {
        const provision = await onchain_lp.computeAskProvision();

        const { id: ofrId } = await onchain_lp.newAsk({
          wants: 10,
          gives: 10,
          fund: provision,
        });
        assert(
          await onchain_lp.market.isLive("asks", ofrId),
          "Offer should be live"
        );
        // this does not work because newAsk is not synced with cache
        // const asks = onchain_lp.asks();
        // assert.strictEqual(
        //   asks.length,
        //   1,
        //   "there should be one ask in the book"
        // );
        // assert.deepStrictEqual(asks[0].id, ofrId, "wrong offer id");

        const missingProvision = await onchain_lp.computeAskProvision({
          id: ofrId,
        });
        assert(
          missingProvision.eq(0),
          `there should be no missing provision for this offer (${missingProvision.toNumber()})`
        );
      });

      it("cancels offer", async () => {
        // huge provision to maker sure refund exceeds gas costs
        const prov = await onchain_lp.computeBidProvision({ gasprice: 12000 });
        const { id: ofrId } = await onchain_lp.newBid({
          wants: 10,
          gives: 20,
          gasprice: 12000,
          fund: prov,
        });
        let prov_before_cancel = await mgv._provider.getBalance(
          await onchain_lp.mgv._signer.getAddress()
        );

        await onchain_lp.retractBid(ofrId, true); // with deprovision
        let prov_after_cancel = await mgv._provider.getBalance(
          await onchain_lp.mgv._signer.getAddress()
        );
        assert(
          prov_after_cancel.gt(prov_before_cancel), // cannot do better because of gas cost
          "Maker was not refunded"
        );
        assert(
          onchain_lp.bids().length === 0,
          "Bid was not removed from the book"
        );

        await onchain_lp.retractBid(ofrId, true);
        let prov_after_cancel2 = await mgv._provider.getBalance(
          await onchain_lp.mgv._signer.getAddress()
        );
        assert(
          prov_after_cancel2.lt(prov_after_cancel), // cannot do better because of gas cost
          "Cancel twice should not provision maker"
        );
      });

      it("updates offer", async () => {
        const { id: ofrId } = await onchain_lp.newAsk({
          wants: 10,
          gives: 20,
          fund: await onchain_lp.computeAskProvision({}),
        });
        const provision = await onchain_lp.computeAskProvision({ id: ofrId });
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
        const tx = await onchain_lp.logic?.setDefaultGasreq(50000);
        await tx?.wait();
        assert.strictEqual(
          50000,
          (await onchain_lp.logic?.contract.ofr_gasreq()).toNumber(),
          "Offer default gasreq not updated"
        );
      });
    });
  });
});
