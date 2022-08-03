// Integration tests for Semibook.ts
import { describe, beforeEach, afterEach, it } from "mocha";
import { expect } from "chai";

import * as mgvTestUtil from "../../src/util/mgvIntegrationTestUtil";
const waitForTransaction = mgvTestUtil.waitForTransaction;
import { newOffer, toWei } from "../util/helpers";

import { Mangrove } from "../../src";

import { Big } from "big.js";

//pretty-print when using console.log
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] = function () {
  return `<Big>${this.toString()}`; // previously just Big.prototype.toString;
};

describe("Semibook integration tests suite", function () {
  let mgv: Mangrove;

  beforeEach(async function () {
    //set mgv object
    mgv = await Mangrove.connect({
      provider: this.server.url,
      privateKey: this.accounts.tester.key,
    });

    mgvTestUtil.setConfig(mgv, this.accounts);

    //shorten polling for faster tests
    (mgv._provider as any).pollingInterval = 10;
    await mgv.contract["fund()"]({ value: toWei(10) });

    mgvTestUtil.initPollOfTransactionTracking(mgv._provider);
  });

  afterEach(async () => {
    mgvTestUtil.stopPollOfTransactionTracking();
    mgv.disconnect();
  });

  // FIXME: Test cache invariants

  describe("getPivotId", () => {
    it("returns `undefined` when offer list is empty", async function () {
      const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getPivotId(Big(1))).to.be.undefined;
    });

    it("loads offers and finds pivot when cache is empty and offer list is not", async function () {
      // Put one offer on asks
      // TODO: Can we explicitly get the id of this offer?
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
      );
      await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

      // Load no offers in cache
      const market = await mgv.market({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 0 },
      });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getPivotId(Big(1))).to.equal(1);
    });

    it("loads offers and finds pivot when cache is partial and price is worse than offers in cache", async function () {
      // Put one offer on asks
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
      );
      // TODO: Can we explicitly get the id of this offer?
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
      );
      await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

      // Load 1 offer in cache
      const market = await mgv.market({
        base: "TokenA",
        quote: "TokenB",
        bookOptions: { maxOffers: 1 },
      });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getPivotId(Big(1.5))).to.equal(1);
    });

    it("returns `undefined` if price is better than best offer", async function () {
      // Put one offer on asks
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
      );

      const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
      const semibook = market.getSemibook("asks");
      expect([...semibook]).to.have.lengthOf(1);
      expect(await semibook.getPivotId(Big(0.5))).to.be.undefined;
    });

    it("returns id of the last offer if price is worse than worst offer", async function () {
      // Put one offer on asks
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
      );
      // TODO: Can we explicitly get the id of this offer?
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
      );

      const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getPivotId(Big(3))).to.equal(2);
    });

    it("returns id of the last offer with a better price", async function () {
      // Put one offer on asks
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
      );
      // TODO: Can we explicitly get the id of this offer?
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
      );
      await waitForTransaction(
        newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
      );

      const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getPivotId(Big(2.5))).to.equal(2);
    });
  });

  describe("estimateVolume", () => {
    (["buy", "sell"] as const).forEach((to) =>
      describe(`estimateVolume({to: ${to}}) - cache tests`, () => {
        it("returns all given as residue when cache and offer list is empty", async function () {
          const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
          const semibook = market.getSemibook("asks");
          expect(await semibook.estimateVolume({ given: 1, to })).to.deep.equal(
            {
              estimatedVolume: Big(0),
              givenResidue: Big(1),
            }
          );
        });

        it("returns correct estimate and residue when cache is empty and offer list is not", async function () {
          // Put one offer on asks
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          // Load no offers in cache
          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: { maxOffers: 0 },
          });
          const semibook = market.getSemibook("asks");
          expect(await semibook.estimateVolume({ given: 1, to })).to.deep.equal(
            {
              estimatedVolume: Big(1),
              givenResidue: Big(0),
            }
          );
        });

        it("returns correct estimate and residue when cache is partial and insufficient while offer list is sufficient", async function () {
          // Put one offer on asks
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          // Load 1 offer in cache
          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: { maxOffers: 1 },
          });
          const semibook = market.getSemibook("asks");
          expect(await semibook.estimateVolume({ given: 2, to })).to.deep.equal(
            {
              estimatedVolume: Big(2),
              givenResidue: Big(0),
            }
          );
        });

        it("returns correct estimate and residue when cache is partial and offer list is insufficient", async function () {
          // Put one offer on asks
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          // Load 1 offer in cache
          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: { maxOffers: 1 },
          });
          const semibook = market.getSemibook("asks");
          expect(await semibook.estimateVolume({ given: 3, to })).to.deep.equal(
            {
              estimatedVolume: Big(2),
              givenResidue: Big(1),
            }
          );
        });
      })
    );

    describe("estimateVolume({to: buy}) - calculation tests", () => {
      it("returns zero when given is zero", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );

        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;
        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 0, to: "buy" })
        ).to.deep.equal({
          estimatedVolume: Big(0),
          givenResidue: Big(0),
        });
      });

      it("estimates all available volume when offer list has 1 offer with insufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 2, to: "buy" })
        ).to.deep.equal({
          estimatedVolume: Big(2),
          givenResidue: Big(1),
        });
      });

      it("estimates all available volume when offer list has multiple offers with insufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 3, to: "buy" })
        ).to.deep.equal({
          estimatedVolume: Big(5),
          givenResidue: Big(1),
        });
      });

      it("estimates volume and no residue when offer list has 1 offer with sufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "4" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 1, to: "buy" })
        ).to.deep.equal({
          estimatedVolume: Big(2),
          givenResidue: Big(0),
        });
      });

      it("estimates volume and no residue when offer list has multiple offers which together have sufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "4" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 2, to: "buy" })
        ).to.deep.equal({
          estimatedVolume: Big(4),
          givenResidue: Big(0),
        });
      });
    });

    describe("estimateVolume({to: sell}) - calculation tests", () => {
      it("returns zero when given is zero", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );

        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;
        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 0, to: "sell" })
        ).to.deep.equal({
          estimatedVolume: Big(0),
          givenResidue: Big(0),
        });
      });

      it("estimates all available volume when offer list has 1 offer with insufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 3, to: "sell" })
        ).to.deep.equal({
          estimatedVolume: Big(1),
          givenResidue: Big(1),
        });
      });

      it("estimates all available volume when offer list has multiple offers with insufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 6, to: "sell" })
        ).to.deep.equal({
          estimatedVolume: Big(2),
          givenResidue: Big(1),
        });
      });

      it("estimates volume and no residue when offer list has 1 offer with sufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "4" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 2, to: "sell" })
        ).to.deep.equal({
          estimatedVolume: Big(1),
          givenResidue: Big(0),
        });
      });

      it("estimates volume and no residue when offer list has multiple offers which together have sufficient volume", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "4" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
        const semibook = market.getSemibook("asks");
        expect(
          await semibook.estimateVolume({ given: 3, to: "sell" })
        ).to.deep.equal({
          estimatedVolume: Big(1.5),
          givenResidue: Big(0),
        });
      });
    });
  });

  describe("initialization options", () => {
    describe("Option.desiredPrice", () => {
      it("does not fail if offer list is empty", async function () {
        const market = await mgv.market({
          base: "TokenA",
          quote: "TokenB",
          bookOptions: {
            desiredPrice: 1,
            chunkSize: 1, // Fetch only 1 offer in each chunk
          },
        });
        const semibook = market.getSemibook("asks");
        expect(semibook.size()).to.equal(0);
      });

      it("fetches all offers if all have a better price", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({
          base: "TokenA",
          quote: "TokenB",
          bookOptions: {
            desiredPrice: 3,
            chunkSize: 1, // Fetch only 1 offer in each chunk
          },
        });
        const semibook = market.getSemibook("asks");
        expect(semibook.size()).to.equal(2);
      });

      it("fetches only one chunk if no offers have a better price", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({
          base: "TokenA",
          quote: "TokenB",
          bookOptions: {
            desiredPrice: 1,
            chunkSize: 1, // Fetch only 1 offer in each chunk
          },
        });
        const semibook = market.getSemibook("asks");
        expect(semibook.size()).to.equal(1);
      });

      it("stops fetching when a chunk with a worse price has been fetched", async function () {
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
        );
        await waitForTransaction(
          newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "4" })
        );
        await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

        const market = await mgv.market({
          base: "TokenA",
          quote: "TokenB",
          bookOptions: {
            desiredPrice: 2,
            chunkSize: 1, // Fetch only 1 offer in each chunk
          },
        });
        const semibook = market.getSemibook("asks");
        expect(semibook.size()).to.equal(3);
      });
    });

    describe("Option.desiredVolume", () => {
      describe("{to: buy}", () => {
        it("does not fail if offer list is empty", async function () {
          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 1,
                what: "base",
                to: "buy",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(0);
        });

        it("fetches all offers if offer list has insufficient volume", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 3,
                what: "base",
                to: "buy",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(2);
        });

        it("fetches only one chunk if it has sufficient volume", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 1,
                what: "base",
                to: "buy",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(1);
        });

        it("stops fetching when sufficient volume has been fetched", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "2" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "3" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "4" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 3,
                what: "base",
                to: "buy",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(3);
        });
      });

      describe("{to: sell}", () => {
        it("does not fail if offer list is empty", async function () {
          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 1,
                what: "quote",
                to: "sell",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(0);
        });

        it("fetches all offers if offer list has insufficient volume", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 3,
                what: "quote",
                to: "sell",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(2);
        });

        it("fetches only one chunk if it has sufficient volume", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 1,
                what: "quote",
                to: "sell",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(1);
        });

        it("stops fetching when sufficient volume has been fetched", async function () {
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "4", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "3", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "2", wants: "1" })
          );
          await waitForTransaction(
            newOffer(mgv, "TokenA", "TokenB", { gives: "1", wants: "1" })
          );
          await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

          const market = await mgv.market({
            base: "TokenA",
            quote: "TokenB",
            bookOptions: {
              desiredVolume: {
                given: 3,
                what: "quote",
                to: "sell",
              },
              chunkSize: 1, // Fetch only 1 offer in each chunk
            },
          });
          const semibook = market.getSemibook("asks");
          expect(semibook.size()).to.equal(3);
        });
      });
    });
  });

  describe("getMaxGasReq", () => {
    it("returns `undefined` when the semibook is empty", async function () {
      const market = await mgv.market({ base: "TokenA", quote: "TokenB" });
      const semibook = market.getSemibook("asks");
      expect(await semibook.getMaxGasReq()).to.be.undefined;
    });

    it("finds max gasreq on both asks and bids side of market", async function () {
      const base = "TokenA";
      const quote = "TokenB";

      const expectedAsksMaxGasReq = 10_011;
      const expectedBidsMaxGasReq = 10_022;

      /* create bids and asks */
      const asks = [
        {
          id: 1,
          wants: "1",
          gives: "1",
          gasreq: expectedAsksMaxGasReq - 100,
          gasprice: 1,
        },
        {
          id: 2,
          wants: "1.2",
          gives: "1",
          gasreq: expectedAsksMaxGasReq,
          gasprice: 3,
        },
        {
          id: 3,
          wants: "1",
          gives: "1.2",
          gasreq: expectedAsksMaxGasReq - 2,
          gasprice: 21,
        },
      ];

      const bids = [
        {
          id: 1,
          wants: "0.99",
          gives: "1",
          gasreq: expectedBidsMaxGasReq - 7,
          gasprice: 11,
        },
        {
          id: 2,
          wants: "1",
          gives: "1.43",
          gasreq: expectedBidsMaxGasReq - 10,
          gasprice: 7,
        },
        {
          id: 3,
          wants: "1.11",
          gives: "1",
          gasreq: expectedBidsMaxGasReq,
          gasprice: 30,
        },
      ];

      for (const ask of asks) {
        await waitForTransaction(newOffer(mgv, base, quote, ask));
      }
      for (const bid of bids) {
        await waitForTransaction(newOffer(mgv, quote, base, bid));
      }

      // wait for offer(s) to be recorded in OB
      await mgvTestUtil.eventsForLastTxHaveBeenGenerated;

      const market = await mgv.market({ base: base, quote: quote });
      const actualAsksMaxGasReq = await market.getBook().asks.getMaxGasReq();
      const actualBidsMaxGasReq = await market.getBook().bids.getMaxGasReq();

      expect(actualAsksMaxGasReq).to.be.equal(expectedAsksMaxGasReq);
      expect(actualBidsMaxGasReq).to.be.equal(expectedBidsMaxGasReq);
    });
  });
});
