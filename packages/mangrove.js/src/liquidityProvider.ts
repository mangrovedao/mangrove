import * as ethers from "ethers";
import { EOA_offer_gasreq } from "./constants";

import Market from "./market";
// syntactic sugar
import { Bigish } from "./types";
import Mangrove from "./mangrove";

/* Note on big.js:
ethers.js's BigNumber (actually BN.js) only handles integers
big.js handles arbitrary precision decimals, which is what we want
for more on big.js vs decimals.js vs. bignumber.js (which is *not* ethers's BigNumber):
  github.com/MikeMcl/big.js/issues/45#issuecomment-104211175
*/
import Big from "big.js";
import { OfferLogic } from ".";
import { Deferred } from "./util";
Big.DP = 20; // precision when dividing
Big.RM = Big.roundHalfUp; // round to nearest

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace LiquidityProvider {
  export type ConstructionParams = {
    mgv: Mangrove;
    logic?: OfferLogic;
    eoa?: string;
    market: Market;
  };
  /** Connect to MangroveOffer.
   *  This basic maker contract will relay new/cancel/update
   *  offer order.
   */

  type OptParams = { gasreq?: number; gasprice?: number };

  export type OfferParams =
    | ({ price: Bigish; volume: Bigish } & OptParams)
    | ({ wants: Bigish; gives: Bigish } & OptParams);
}

/**
 * The Maker class connects to a Maker contract.
 * It posts onchain offers.
 *
 * Maker initialization needs to store the network name, so you cannot
 * directly use the constructor. Instead of `new Maker(...)`, do
 *
 * `await Maker.connect(...)`
 */
// Maker.withdrawDeposit()
// Maker.deposit(n)
class LiquidityProvider {
  mgv: Mangrove; // API abstraction of the Mangrove ethers.js contract
  logic?: OfferLogic; // API abstraction of the underlying offer logic ethers.js contract
  eoa?: string; // signer's address
  market: Market; // API market abstraction over Mangrove's offer lists

  constructor(p: LiquidityProvider.ConstructionParams) {
    if (p.eoa || p.logic) {
      this.mgv = p.mgv;
      this.logic = p.logic;
      this.market = p.market;
      this.eoa = p.eoa;
    } else {
      throw Error(
        "Missing EOA or onchain logic to build a Liquidity Provider object"
      );
    }
  }

  computeOfferProvision(
    ba: "bids" | "asks",
    opts: { id?: number; gasreq?: number }
  ): Promise<Big> {
    return this.getMissingProvision(ba, opts);
  }

  computeBidProvision(opts: { id?: number; gasreq?: number }): Promise<Big> {
    return this.getMissingProvision("bids", opts);
  }

  computeAskProvision(opts: { id?: number; gasreq?: number }): Promise<Big> {
    return this.getMissingProvision("asks", opts);
  }

  /** List all of the maker's asks */
  asks(): Market.Offer[] {
    const address = this.logic ? this.logic.address : this.eoa;
    return this.market.book().asks.filter((ofr) => ofr.maker === address);
  }

  /** List all of the maker's bids */
  bids(): Market.Offer[] {
    const address = this.logic ? this.logic.address : this.eoa;
    return this.market.book().bids.filter((ofr) => ofr.maker === address);
  }

  /**
   *  Given offer params (bids/asks + price info as wants&gives or price&volume),
   *  return {price,wants,gives}
   */
  #normalizeOfferParams(
    p: { ba: "bids" | "asks" } & LiquidityProvider.OfferParams
  ): {
    price: Big;
    wants: Big;
    gives: Big;
    gasreq?: number;
    gasprice?: number;
  } {
    let wants, gives, price;
    // deduce price from wants&gives, or deduce wants&gives from volume&price
    if ("gives" in p) {
      [wants, gives] = [p.wants, p.gives];
      let [base_amt, quote_amt] = [gives, wants];
      if (p.ba === "bids") {
        [base_amt, quote_amt] = [quote_amt, base_amt];
      }
      price = Big(quote_amt).div(base_amt);
    } else {
      price = p.price;
      [wants, gives] = [Big(p.volume).mul(price), Big(p.volume)];
      if (p.ba === "bids") {
        [wants, gives] = [gives, wants];
      }
    }
    const gasreq = p.gasreq;
    const gasprice = p.gasprice;
    return { wants, gives, price, gasreq, gasprice };
  }

  /** Post a new ask */
  newAsk(
    p: LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ id: number; event: ethers.providers.Log }> {
    return this.newOffer({ ba: "asks", ...p }, overrides);
  }

  /** Post a new bid */
  newBid(
    p: LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ id: number; event: ethers.providers.Log }> {
    return this.newOffer({ ba: "bids", ...p }, overrides);
  }

  // returns allowance for Mangrove transfer of liquidity provider's tokens
  mangroveAllowance(tokenName: string): Promise<Big> {
    return this.logic
      ? this.logic.mangroveAllowance(tokenName)
      : this.mgv
          .token(tokenName)
          .allowance({ owner: this.eoa, spender: this.mgv._address });
  }

  approveMangrove(
    tokenName: string,
    amount?: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.#proxy().approveMangrove(tokenName, amount, overrides);
  }

  approveMangroveForBase(
    amount?: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.approveMangrove(this.market.base.name, amount, overrides);
  }
  approveMangroveForQuote(
    amount?: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.approveMangrove(this.market.quote.name, amount, overrides);
  }

  fundMangrove(
    amount: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.#proxy().fundMangrove(amount, overrides);
  }

  /* Create a new offer, let mangrove decide the gasprice. Return a promise fulfilled when mangrove.js has received the tx and updated itself. The tx returns the new offer id.
 
    If the tx created more than one offer, the id of the first one to be written is returned.
  
    Note: we do not return a TransactionResponse because it could be possible to :
     * wait for the response to be mined
     * try to read market.book
     * still get the old book (before new offer is inserted)
    This is due to ethers.js subscription calling the txresponse first and
    updating subscriptions only later.
    To avoid inconsistency we do a market.once(...) which fulfills the promise once the offer has been created.
  */

  #proxy(): Mangrove | OfferLogic {
    return this.logic ? this.logic : this.mgv;
  }
  async #gasreq(): Promise<number> {
    return this.logic ? await this.logic.getDefaultGasreq() : EOA_offer_gasreq;
  }

  async newOffer(
    p: { ba: "bids" | "asks" } & LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ id: number; pivot: number; event: ethers.providers.Log }> {
    const { wants, gives, price, gasreq, gasprice } =
      this.#normalizeOfferParams(p);
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(p.ba);
    const pivot = await this.market.getPivotId(p.ba, price);

    const txHashDeferred = new Deferred<string>();

    const res = this.market.once(
      (cbArg, _event, ethersEvent) => ({
        id: cbArg.offer.id,
        event: ethersEvent,
        pivot: pivot,
      }),
      async (_cbArg, _event, ethersEvent) =>
        (await txHashDeferred.promise) === ethersEvent.transactionHash
    );

    const resp = await this.#proxy().contract.newOffer(
      outbound_tkn.address,
      inbound_tkn.address,
      inbound_tkn.toUnits(wants),
      outbound_tkn.toUnits(gives),
      gasreq ? gasreq : await this.#gasreq(),
      gasprice ? gasprice : 0,
      pivot ?? 0,
      overrides
    );
    txHashDeferred.resolve(resp.hash);

    return res;
  }

  /** Update an existing ask */
  updateAsk(
    id: number,
    p: LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ event: ethers.providers.Log }> {
    return this.updateOffer(id, { ba: "asks", ...p }, overrides);
  }

  /** Update an existing offer */
  updateBid(
    id: number,
    p: LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ event: ethers.providers.Log }> {
    return this.updateOffer(id, { ba: "bids", ...p }, overrides);
  }

  /* Update an existing offer. Non-specified parameters will be copied from current
     data in the offer. Reuse current offer's gasprice.
     Input should be {ba:"bids"|"asks"} and price info as wants&gives or as price&volume
     */
  async updateOffer(
    id: number,
    p: { ba: "bids" | "asks" } & LiquidityProvider.OfferParams,
    overrides: ethers.PayableOverrides = {}
  ): Promise<{ event: ethers.providers.Log }> {
    const offerList = p.ba === "asks" ? this.asks() : this.bids();
    const offer = offerList.find((o) => o.id === id);
    if (typeof offer === "undefined") {
      throw Error(
        `No offer in ${p} with id ${id} owned by this maker contract.`
      );
    }
    const txHashDeferred = new Deferred<string>();
    const res = this.market.once(
      (_cbArg, _event, ethersEvent) => ({ event: ethersEvent }),
      async (_cbArg, _event, ethersEvent) =>
        (await txHashDeferred.promise) === ethersEvent.transactionHash
    );

    const { wants, gives, price, gasreq, gasprice } =
      this.#normalizeOfferParams(p);
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(p.ba);

    const resp = await this.#proxy().contract.updateOffer(
      outbound_tkn.address,
      inbound_tkn.address,
      inbound_tkn.toUnits(wants),
      outbound_tkn.toUnits(gives),
      gasreq ? gasreq : await this.#gasreq(),
      gasprice ? gasprice : offer.gasprice,
      (await this.market.getPivotId(p.ba, price)) ?? 0,
      id,
      overrides
    );
    txHashDeferred.resolve(resp.hash);
    return res;
  }

  /** Cancel an ask. If deprovision is true, will return the offer's provision to the maker balance at Mangrove. */
  cancelAsk(
    id: number,
    deprovision = false,
    overrides: ethers.Overrides = {}
  ): Promise<void> {
    return this.cancelOffer("asks", id, deprovision, overrides);
  }

  /** Cancel a bid. If deprovision is true, will return the offer's provision to the maker balance at Mangrove. */
  cancelBid(
    id: number,
    deprovision = false,
    overrides: ethers.Overrides = {}
  ): Promise<void> {
    return this.cancelOffer("bids", id, deprovision, overrides);
  }

  /* Cancel an offer. Return a promise fulfilled when mangrove.js has received the tx and updated itself. If deprovision is true, will return the offer's provision to the maker balance at Mangrove. */
  async cancelOffer(
    ba: "bids" | "asks",
    id: number,
    deprovision = false,
    overrides: ethers.Overrides = {}
  ): Promise<void> {
    const txHashDeferred = new Deferred<string>();
    const res = this.market.once(
      (/*cbArg, event, ethersEvent*/) => {
        /*empty*/
      },
      async (_cbArg, _event, ethersEvent) => {
        const b =
          (await txHashDeferred.promise) === ethersEvent.transactionHash;
        console.log(b);
        return b;
      }
    );
    console.log("here");
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(ba);
    const resp = await this.#proxy().contract.retractOffer(
      outbound_tkn.address,
      inbound_tkn.address,
      id,
      deprovision,
      overrides
    );
    txHashDeferred.resolve(resp.hash);
    return res;
  }
  /** Get the current balance the liquidity provider has in Mangrove */
  balanceOnMangrove(overrides: ethers.Overrides = {}): Promise<Big> {
    if (this.logic) {
      // if liquidity provider has a logic, then one should ask its contract what is the balance of signer (could be multiple users)
      return this.logic.balanceOnMangrove(overrides);
    } else {
      // if liquidity provider has no logic, balance is the balanceOf(signer)
      return this.mgv.balanceOf(this.eoa, overrides);
    }
  }

  tokenBalance(
    tokenName: string,
    overrides: ethers.Overrides = {}
  ): Promise<Big> {
    if (this.logic) {
      // if liquidity provider has a logic, then one should ask its contract what is the balance of signer (could be multiple users)
      return this.logic.tokenBalance(tokenName, overrides);
    } else {
      // if liquidity provider has no logic, balance is the token.balanceOf(signer)
      return this.mgv.token(tokenName).balanceOf(this.eoa, overrides);
    }
  }

  withdraw(
    amount: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    if (this.logic) {
      return this.logic.withdrawFromMangrove(amount, overrides);
    } else {
      return this.mgv.contract.withdraw(
        this.mgv.toUnits(amount, 18),
        overrides
      );
    }
  }

  async getMissingProvision(
    ba: "bids" | "asks",
    opts: { id?: number; gasreq?: number; gasprice?: number } = {}
  ): Promise<Big> {
    const gasreq = opts.gasreq ? opts.gasreq : await this.#gasreq();
    const gasprice = opts.gasprice ? opts.gasprice : 0;
    const bounty = await this.market.getOfferProvision(ba, gasreq, gasprice);
    let lockedProvision = Big(0);
    if (opts.id) {
      const offer = await this.market.offerInfo(ba, opts.id);
      const prov_in_gwei: Big = new Big(
        (offer.gasreq + offer.offer_gasbase) * offer.gasprice
      );
      lockedProvision = prov_in_gwei.div(10 ** 9);
    }
    const balance = await this.balanceOnMangrove();
    const currentOfferProvision = lockedProvision.add(balance);
    return currentOfferProvision.gte(bounty)
      ? new Big(0)
      : bounty.sub(currentOfferProvision);
  }
}

export default LiquidityProvider;
