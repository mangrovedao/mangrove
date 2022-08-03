import { logger } from "./util/logger";
import * as ethers from "ethers";
import { BigNumber } from "ethers"; // syntactic sugar
import { Bigish, typechain } from "./types";
import Mangrove from "./mangrove";
import MgvToken from "./mgvtoken";
import { OrderSummaryEvent } from "./types/typechain/MangroveOrder";
import Semibook from "./semibook";
import { Deferred } from "./util";

let canConstructMarket = false;

const MAX_MARKET_ORDER_GAS = 6500000;

/* Note on big.js:
ethers.js's BigNumber (actually BN.js) only handles integers
big.js handles arbitrary precision decimals, which is what we want
for more on big.js vs decimals.js vs. bignumber.js (which is *not* ethers's BigNumber):
  github.com/MikeMcl/big.js/issues/45#issuecomment-104211175
*/
import Big from "big.js";

export const bookOptsDefault: Market.BookOptions = {
  maxOffers: Semibook.DEFAULT_MAX_OFFERS,
};

import type { Awaited } from "ts-essentials";
import * as TCM from "./types/typechain/Mangrove";

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Market {
  export type MgvReader = typechain.MgvReader;
  export type Failure = {
    offerId: number;
    reason: string;
    FailToDeliver?: Big;
    volumeGiven?: Big;
  };
  export type Success = {
    offerId: number;
    got: Big;
    gave: Big;
  };
  export type Summary = {
    got: Big;
    gave: Big;
    partialFill: boolean;
    penalty: Big;
    offerId?: number; // id of resting order if any
  };
  export type OrderResult = {
    txReceipt: ethers.ContractReceipt;
    summary: Summary;
    successes: Success[];
    tradeFailures: Failure[];
    posthookFailures: Failure[];
  };
  export type BookSubscriptionEvent =
    | ({ name: "OfferWrite" } & TCM.OfferWriteEvent)
    | ({ name: "OfferFail" } & TCM.OfferFailEvent)
    | ({ name: "OfferSuccess" } & TCM.OfferSuccessEvent)
    | ({ name: "OfferRetract" } & TCM.OfferRetractEvent)
    | ({ name: "SetGasbase" } & TCM.SetGasbaseEvent);

  export type TradeParams = {
    slippage?: number;
    restingOrder?: RestingOrderParams;
  } & (
    | { volume: Bigish; price: Bigish | null }
    | { total: Bigish; price: Bigish | null }
    | { wants: Bigish; gives: Bigish; fillWants?: boolean }
  );

  export type RestingOrderParams = {
    partialFillNotAllowed?: boolean;
    retryNumber?: number;
    gasForMarketOrder?: number;
    blocksToLiveForRestingOrder?: number;
    provision: Bigish;
  };

  /**
   * Specification of how much volume to (potentially) trade on the market.
   *
   * `{given:100, what:"base", to:"buy"}` means buying 100 base tokens.
   *
   * `{given:10, what:"quote", to:"sell"})` means selling 10 quote tokens.
   */
  export type VolumeParams = Semibook.VolumeParams & {
    /** Whether `given` is the market's base or quote. */
    what: "base" | "quote";
  };
  export type DirectionlessVolumeParams = Omit<VolumeParams, "to">;

  /**
   * Options that control how the book cache behaves.
   */
  export type BookOptions = {
    /** The maximum number of offers to store in the cache.
     *
     * `maxOffers` and `desiredPrice` are mutually exclusive.
     */
    maxOffers?: number;
    /** The number of offers to fetch in one call.
     *
     * Defaults to `maxOffers` if it is set and positive; Otherwise `Semibook.DEFAULT_MAX_OFFERS` is used. */
    chunkSize?: number;
    /** The price that is expected to be used in calls to the market.
     * The cache will initially contain all offers with this price or better.
     * This can be useful in order to ensure a good pivot is readily available.
     *
     * `maxOffers` and `desiredPrice` are mutually exclusive.
     */
    desiredPrice?: Bigish;
    /**
     * The volume that is expected to be used in trades on the market.
     */
    desiredVolume?: VolumeParams;
  };

  export type Offer = {
    id: number;
    prev: number | undefined;
    next: number | undefined;
    gasprice: number;
    maker: string;
    gasreq: number;
    offer_gasbase: number;
    wants: Big;
    gives: Big;
    volume: Big;
    price: Big;
  };

  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace BookReturns {
    type _BookReturns = Awaited<
      ReturnType<Market.MgvReader["functions"]["offerList"]>
    >;
    export type Indices = _BookReturns[1];
    export type Offers = _BookReturns[2];
    export type Details = _BookReturns[3];
  }

  export type BookSubscriptionCbArgument = {
    ba: "asks" | "bids";
    offerId: number;
    offer?: Offer; // if undefined, offer was not found/inserted in local cache
  } & (
    | { type: "OfferWrite" }
    | {
        type: "OfferFail";
        taker: string;
        takerWants: Big;
        takerGives: Big;
        mgvData: string;
      }
    | { type: "OfferSuccess"; taker: string; takerWants: Big; takerGives: Big }
    | { type: "OfferRetract" }
  );

  export type MarketCallback<T> = (
    cbArg: BookSubscriptionCbArgument,
    event?: BookSubscriptionEvent,
    ethersLog?: ethers.providers.Log
  ) => T;
  export type StorableMarketCallback = MarketCallback<any>;
  export type MarketFilter = MarketCallback<boolean | Promise<boolean>>;
  export type SubscriptionParam =
    | { type: "multiple" }
    | {
        type: "once";
        ok: (...a: any[]) => any;
        ko: (...a: any[]) => any;
        filter?: (...a: any[]) => boolean | Promise<boolean>;
      };

  export type Book = { asks: Semibook; bids: Semibook };

  export type VolumeEstimate = {
    estimatedVolume: Big;
    givenResidue: Big;
  };
}

// no unsubscribe yet
/**
 * The Market class focuses on a Mangrove market.
 * On-chain, markets are implemented as two offer lists,
 * one for asks (base,quote), the other for bids (quote,base).
 *
 * Market initialization needs to store the network name, so you cannot
 * directly use the constructor. Instead of `new Market(...)`, do
 *
 * `await Market.connect(...)`
 */
class Market {
  mgv: Mangrove;
  base: MgvToken;
  quote: MgvToken;
  #subscriptions: Map<Market.StorableMarketCallback, Market.SubscriptionParam>;
  #blockSubscriptions: ThresholdBlockSubscriptions;
  #asksSemibook: Semibook;
  #bidsSemibook: Semibook;
  #initClosure?: () => Promise<void>;

  static async connect(params: {
    mgv: Mangrove;
    base: string;
    quote: string;
    bookOptions?: Market.BookOptions;
  }): Promise<Market> {
    canConstructMarket = true;
    const market = new Market(params);
    canConstructMarket = false;
    if (params["noInit"]) {
      market.#initClosure = () => {
        return market.#initialize(params.bookOptions);
      };
    } else {
      await market.#initialize(params.bookOptions);
    }

    return market;
  }

  /* Stop listening to events from mangrove */
  disconnect(): void {
    this.#asksSemibook.disconnect();
    this.#bidsSemibook.disconnect();
  }

  /* wait until all currently pending semibook operations have been completed -- not as good as explicitly waiting for a specific tx to be processed by mangrove.js, but works as a temporary solution */
  async awaitCurrentProcessing(): Promise<void> {
    await Promise.all([
      this.#asksSemibook.awaitCurrentProcessing(),
      this.#bidsSemibook.awaitCurrentProcessing(),
    ]);
  }

  /**
   * Initialize a new `params.base`:`params.quote` market.
   *
   * `params.mgv` will be used as mangrove instance
   */
  private constructor(params: { mgv: Mangrove; base: string; quote: string }) {
    if (!canConstructMarket) {
      throw Error(
        "Mangrove Market must be initialized async with Market.connect (constructors cannot be async)"
      );
    }
    this.#subscriptions = new Map();

    this.mgv = params.mgv;

    this.base = this.mgv.token(params.base);
    this.quote = this.mgv.token(params.quote);
  }

  initialize(): Promise<void> {
    if (typeof this.#initClosure === "undefined") {
      throw new Error("Cannot initialize already initialized market.");
    } else {
      const initClosure = this.#initClosure;
      this.#initClosure = undefined;
      return initClosure();
    }
  }

  async #initialize(opts: Market.BookOptions = bookOptsDefault): Promise<void> {
    const semibookDesiredVolume =
      opts.desiredVolume === undefined
        ? undefined
        : { given: opts.desiredVolume.given, to: opts.desiredVolume.to };
    const isVolumeDesiredForAsks =
      opts.desiredVolume !== undefined &&
      ((opts.desiredVolume.what === "base" &&
        opts.desiredVolume.to === "buy") ||
        (opts.desiredVolume.what === "quote" &&
          opts.desiredVolume.to === "sell"));
    const isVolumeDesiredForBids =
      opts.desiredVolume !== undefined &&
      ((opts.desiredVolume.what === "base" &&
        opts.desiredVolume.to === "sell") ||
        (opts.desiredVolume.what === "quote" &&
          opts.desiredVolume.to === "buy"));

    const getSemibookOpts: (ba: "bids" | "asks") => Semibook.Options = (
      ba
    ) => ({
      maxOffers: opts.maxOffers,
      chunkSize: opts.chunkSize,
      desiredPrice: opts.desiredPrice,
      desiredVolume:
        (ba === "asks" && isVolumeDesiredForAsks) ||
        (ba === "bids" && isVolumeDesiredForBids)
          ? semibookDesiredVolume
          : undefined,
    });

    const asksPromise = Semibook.connect(
      this,
      "asks",
      (e) => this.#semibookEventCallback(e),
      (n) => this.#semibookBlockCallback(n),
      getSemibookOpts("asks")
    );
    const bidsPromise = Semibook.connect(
      this,
      "bids",
      (e) => this.#semibookEventCallback(e),
      (n) => this.#semibookBlockCallback(n),
      getSemibookOpts("bids")
    );
    this.#asksSemibook = await asksPromise;
    this.#bidsSemibook = await bidsPromise;

    // start block events from the last block seen by both semibooks
    const lastBlock = Math.min(
      this.#asksSemibook.lastReadBlockNumber(),
      this.#bidsSemibook.lastReadBlockNumber()
    );
    if (!lastBlock) {
      throw Error("Could not retrieve last block number");
    }
    this.#blockSubscriptions = new ThresholdBlockSubscriptions(lastBlock, 2);
  }

  #semibookBlockCallback(n: number): void {
    // This callback may be called by the semibooks before initialization is complete,
    // so #blockSubscriptions may not have been initialized yet.
    if (this.#blockSubscriptions) {
      this.#blockSubscriptions.increaseCount(n);
    }
  }

  async #semibookEventCallback({
    cbArg,
    event,
    ethersLog: ethersLog,
  }: Semibook.Event): Promise<void> {
    for (const [cb, params] of this.#subscriptions) {
      if (params.type === "once") {
        let isFilterSatisfied: boolean;
        if (!("filter" in params)) {
          isFilterSatisfied = true;
        } else {
          const filterResult = params.filter(cbArg, event, ethersLog);
          isFilterSatisfied =
            typeof filterResult === "boolean"
              ? filterResult
              : await filterResult;
        }
        if (isFilterSatisfied) {
          this.#subscriptions.delete(cb);
          Promise.resolve(cb(cbArg, event, ethersLog)).then(
            params.ok,
            params.ko
          );
        }
      } else {
        cb(cbArg, event, ethersLog);
      }
    }
  }

  /**
   * Return the semibooks of this market.
   *
   * Asks are standing offers to sell base and buy quote.
   * Bids are standing offers to buy base and sell quote.
   * All prices are in quote/base, all volumes are in base.
   * Order is from best to worse from taker perspective.
   */
  getBook(): Market.Book {
    return {
      asks: this.#asksSemibook,
      bids: this.#bidsSemibook,
    };
  }

  /** Trigger `cb` after block `n` has been seen. */
  afterBlock<T>(n: number, cb: (number) => T): Promise<T> {
    return this.#blockSubscriptions.subscribe(n, cb);
  }

  /**
   * Return the asks or bids semibook
   */
  getSemibook(ba: "bids" | "asks"): Semibook {
    return ba === "asks" ? this.#asksSemibook : this.#bidsSemibook;
  }

  async requestBook(
    opts: Market.BookOptions = bookOptsDefault
  ): Promise<{ asks: Market.Offer[]; bids: Market.Offer[] }> {
    const asksPromise = this.#asksSemibook.requestOfferListPrefix(opts);
    const bidsPromise = this.#bidsSemibook.requestOfferListPrefix(opts);
    return {
      asks: await asksPromise,
      bids: await bidsPromise,
    };
  }

  async isActive(): Promise<boolean> {
    const config = await this.config();
    return config.asks.active && config.bids.active;
  }

  async isLive(ba: "bids" | "asks", offerId: number): Promise<boolean> {
    const offer: Market.Offer = await this.getSemibook(ba).offerInfo(offerId);
    return offer.gives.gt(0);
  }

  /** Given a price, find the id of the immediately-better offer in the
   * book. If there is no offer with a better price, `undefined` is returned.
   */
  async getPivotId(
    ba: "asks" | "bids",
    price: Bigish
  ): Promise<number | undefined> {
    return ba === "asks"
      ? await this.#asksSemibook.getPivotId(price)
      : await this.#bidsSemibook.getPivotId(price);
  }

  async getOfferProvision(
    ba: "bids" | "asks",
    gasreq: number,
    gasprice: number
  ): Promise<Big> {
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);
    const prov = await this.mgv.readerContract.getProvision(
      outbound_tkn.address,
      inbound_tkn.address,
      gasreq,
      gasprice
    );
    return this.mgv.fromUnits(prov, 18);
  }

  getBidProvision(gasreq: number, gasprice: number): Promise<Big> {
    return this.getOfferProvision("bids", gasreq, gasprice);
  }
  getAskProvision(gasreq: number, gasprice: number): Promise<Big> {
    return this.getOfferProvision("asks", gasreq, gasprice);
  }

  bidInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("bids", offerId);
  }

  askInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("asks", offerId);
  }

  /** Returns struct containing offer details in the current market */
  async offerInfo(ba: "bids" | "asks", offerId: number): Promise<Market.Offer> {
    return ba === "asks"
      ? this.#asksSemibook.offerInfo(offerId)
      : this.#bidsSemibook.offerInfo(offerId);
  }

  /**
   * Market buy order. Will attempt to buy base token using quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: buy `volume` base tokens for a max average price of `price`. Set `price` to null for a true market order. `fillWants` will be true.
   * - `{total,price}` : buy as many base tokens as possible using up to `total` quote tokens, with a max average price of `price`. Set `price` to null for a true market order. `fillWants` will be false.
   * - `{wants,gives,fillWants?}`: accept implicit max average price of `gives/wants`
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * - `wants` tokens have been bought.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.buy({volume: 100, price: '1.01'}) //use strings to be exact
   * ```
   */
  buy(
    params: Market.TradeParams,
    overrides: ethers.Overrides = {}
  ): Promise<Market.OrderResult> {
    let _wants: Big, _gives: Big, fillWants: boolean;
    if ("price" in params) {
      if ("volume" in params) {
        _wants = Big(params.volume);
        _gives =
          params.price === null
            ? Big(2).pow(256).minus(1)
            : _wants.mul(params.price);
        fillWants = true;
      } else {
        _gives = Big(params.total);
        _wants = params.price === null ? Big(0) : _gives.div(params.price);
        fillWants = false;
      }
    } else {
      _wants = Big(params.wants);
      _gives = Big(params.gives);
      fillWants = "fillWants" in params ? params.fillWants : true;
    }

    const slippage = validateSlippage(params.slippage);

    const __gives = _gives.mul(100 + slippage).div(100);
    const wants = this.base.toUnits(_wants);
    const gives = this.quote.toUnits(__gives);

    if (params.restingOrder) {
      const makerWants = wants;
      const makerGives = this.quote.toUnits(_gives);

      return this.#restingOrder(
        {
          gives,
          makerGives,
          wants,
          makerWants,
          orderType: "buy",
          fillWants,
          params: params.restingOrder,
        },
        overrides
      );
    } else {
      return this.#marketOrder(
        { gives, wants, orderType: "buy", fillWants },
        overrides
      );
    }
  }

  /**
   * Market sell order. Will attempt to sell base token for quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: sell `volume` base tokens for a min average price of `price`. Set `price` to null for a true market order. `fillWants` will be false.
   * - `{total,price}` : sell as many base tokens as possible buying up to `total` quote tokens, with a min average price of `price`. Set `price` to null. `fillWants` will be true.
   * - `{wants,gives,fillWants?}`: accept implicit min average price of `gives/wants`. `fillWants` will be false by default.
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * -`gives` tokens have been sold.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.sell({volume: 100, price: 1})
   * ```
   */
  sell(
    params: Market.TradeParams,
    overrides: ethers.Overrides = {}
  ): Promise<Market.OrderResult> {
    let _wants, _gives, fillWants;
    if ("price" in params) {
      if ("volume" in params) {
        _gives = Big(params.volume);
        _wants = params.price === null ? 0 : _gives.mul(params.price);
        fillWants = false;
      } else {
        _wants = Big(params.total);
        _gives =
          params.price === null
            ? Big(2).pow(256).minus(1)
            : _wants.div(params.price);
        fillWants = true;
      }
    } else {
      _wants = Big(params.wants);
      _gives = Big(params.gives);
      fillWants = "fillWants" in params ? params.fillWants : false;
    }

    const slippage = validateSlippage(params.slippage);

    const __wants = _wants.mul(100 - slippage).div(100);
    const gives = this.base.toUnits(_gives);
    const wants = this.quote.toUnits(__wants);

    if (params.restingOrder) {
      const makerGives = gives;
      const makerWants = this.quote.toUnits(_wants);
      return this.#restingOrder(
        {
          gives,
          makerGives,
          wants,
          makerWants,
          orderType: "sell",
          fillWants,
          params: params.restingOrder,
        },
        overrides
      );
    } else {
      return this.#marketOrder(
        { wants, gives, orderType: "sell", fillWants },
        overrides
      );
    }
  }

  #resultOfEvent(
    evt: ethers.Event,
    got_bq: "base" | "quote",
    gave_bq: "base" | "quote",
    fillWants: boolean,
    takerWants: ethers.BigNumber,
    takerGives: ethers.BigNumber,
    result: Market.OrderResult
  ): Market.OrderResult {
    switch (evt.event) {
      case "OrderComplete": {
        const event = evt as TCM.OrderCompleteEvent;
        result.summary = {
          got: this[got_bq].fromUnits(event.args.takerGot),
          gave: this[gave_bq].fromUnits(event.args.takerGave),
          partialFill: fillWants
            ? event.args.takerGot.lt(takerWants)
            : event.args.takerGave.lt(takerGives),
          penalty: this.mgv.fromUnits(event.args.penalty, 18),
        };
        return result;
      }
      case "OfferSuccess": {
        const event = evt as TCM.OfferSuccessEvent;
        result.successes.push({
          offerId: event.args.id.toNumber(),
          got: this[got_bq].fromUnits(event.args.takerWants),
          gave: this[gave_bq].fromUnits(event.args.takerGives),
        });
        return result;
      }
      case "OfferFail": {
        const event = evt as TCM.OfferFailEvent;
        result.tradeFailures.push({
          offerId: event.args.id.toNumber(),
          reason: event.args.mgvData,
          FailToDeliver: this[got_bq].fromUnits(event.args.takerWants),
          volumeGiven: this[gave_bq].fromUnits(event.args.takerGives),
        });
        return result;
      }
      case "PosthookFail": {
        const event = evt as TCM.PosthookFailEvent;
        result.posthookFailures.push({
          offerId: event.args.offerId.toNumber(),
          reason: event.args.posthookData,
        });
        return result;
      }
      case "OrderSummary": {
        const event = evt as OrderSummaryEvent;
        result.summary = {
          got: this[got_bq].fromUnits(event.args.takerGot),
          gave: this[gave_bq].fromUnits(event.args.takerGave),
          partialFill: fillWants
            ? event.args.takerGot.lt(takerWants)
            : event.args.takerGave.lt(takerGives),
          penalty: this.mgv.fromUnits(event.args.penalty, 18),
          offerId: event.args.restingOrderId.toNumber(),
        };
        return result;
      }
      default: {
        return result;
      }
    }
  }
  /**
   * Low level Mangrove market order.
   * If `orderType` is `"buy"`, the base/quote market will be used,
   *
   * If `orderType` is `"sell"`, the quote/base market will be used,
   *
   * `fillWants` defines whether the market order stops immediately once `wants` tokens have been purchased or whether it tries to keep going until `gives` tokens have been spent.
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token.
   *
   * Returns a promise for market order result after 1 confirmation.
   * Will throw on same conditions as ethers.js `transaction.wait`.
   */
  async #marketOrder(
    {
      wants,
      gives,
      orderType,
      fillWants,
    }: {
      wants: ethers.BigNumber;
      gives: ethers.BigNumber;
      orderType: "buy" | "sell";
      fillWants: boolean;
    },
    overrides: ethers.Overrides
  ): Promise<Market.OrderResult> {
    const [outboundTkn, inboundTkn] =
      orderType === "buy" ? [this.base, this.quote] : [this.quote, this.base];

    logger.debug("Creating market order", {
      contextInfo: "market.marketOrder",
      data: {
        outboundTkn: outboundTkn.name,
        inboundTkn: inboundTkn.name,
        fillWants: fillWants,
      },
    });
    // user defined gasLimit overrides estimates
    if (!overrides.gasLimit) {
      overrides.gasLimit = await this.estimateGas(orderType, wants);
    }
    const response = await this.mgv.contract.marketOrder(
      outboundTkn.address,
      inboundTkn.address,
      wants,
      gives,
      fillWants,
      overrides
    );
    const receipt = await response.wait();

    let result: Market.OrderResult = {
      txReceipt: receipt,
      summary: undefined,
      successes: [],
      tradeFailures: [],
      posthookFailures: [],
    };
    //last OrderComplete is ours!
    logger.debug("Market order raw receipt", {
      contextInfo: "market.marketOrder",
      data: { receipt: receipt },
    });
    const got_bq = orderType === "buy" ? "base" : "quote";
    const gave_bq = orderType === "buy" ? "quote" : "base";
    for (const evt of receipt.events) {
      if (
        evt.address === this.mgv._address &&
        (!evt.args.taker || receipt.from === evt.args.taker)
      ) {
        result = this.#resultOfEvent(
          evt,
          got_bq,
          gave_bq,
          fillWants,
          wants,
          gives,
          result
        );
      }
    }
    if (!result.summary) {
      throw Error("market order went wrong");
    }
    return result;
  }

  async #restingOrder(
    {
      wants,
      makerWants,
      gives,
      makerGives,
      orderType,
      fillWants,
      params,
    }: {
      wants: ethers.BigNumber;
      makerWants: ethers.BigNumber;
      gives: ethers.BigNumber;
      makerGives: ethers.BigNumber;
      orderType: "buy" | "sell";
      fillWants: boolean;
      params: Market.RestingOrderParams;
    },
    overrides: ethers.Overrides
  ): Promise<Market.OrderResult> {
    const overrides_ = {
      ...overrides,
      value: this.mgv.toUnits(params.provision, 18),
    };

    // user defined gasLimit overrides estimates
    overrides_.gasLimit = overrides_.gasLimit
      ? overrides_.gasLimit
      : await this.estimateGas(orderType, wants);

    const response = await this.mgv.orderContract.take(
      {
        base: this.base.address,
        quote: this.quote.address,
        partialFillNotAllowed: params.partialFillNotAllowed
          ? params.partialFillNotAllowed
          : false,
        selling: orderType === "sell",
        wants: wants,
        makerWants: makerWants,
        gives: gives,
        makerGives: makerGives,
        restingOrder: true,
        retryNumber: params.retryNumber ? params.retryNumber : 0,
        gasForMarketOrder: params.gasForMarketOrder
          ? params.gasForMarketOrder
          : 0,
        blocksToLiveForRestingOrder: params.blocksToLiveForRestingOrder
          ? params.blocksToLiveForRestingOrder
          : 0,
      },
      overrides_
    );
    const receipt = await response.wait();

    let result: Market.OrderResult = {
      txReceipt: receipt,
      summary: undefined,
      successes: [],
      tradeFailures: [],
      posthookFailures: [],
    };
    const got_bq = orderType === "buy" ? "base" : "quote";
    const gave_bq = orderType === "buy" ? "quote" : "base";
    //last OrderComplete is ours!
    logger.debug("Resting order raw receipt", {
      contextInfo: "market.restingOrder",
      data: { receipt: receipt },
    });
    // check last `OrderComplete` event emitted by `MangroveOrder`
    for (const evt of receipt.events) {
      if (
        evt.address === this.mgv.orderContract.address &&
        (!evt.args.taker || receipt.from === evt.args.taker)
      ) {
        result = this.#resultOfEvent(
          evt,
          got_bq,
          gave_bq,
          fillWants,
          wants,
          gives,
          result
        );
      }
    }
    if (!result.summary) {
      throw Error("resting order went wrong");
    }
    // if resting order was not posted, result.summary is still undefined.
    return result;
  }

  async estimateGas(bs: "buy" | "sell", volume: BigNumber): Promise<BigNumber> {
    const semibook = bs === "buy" ? this.#asksSemibook : this.#bidsSemibook;
    const {
      local: { density, offer_gasbase },
    } = await semibook.getRawConfig();

    const maxGasreqOffer = (await semibook.getMaxGasReq()) ?? 0;
    const maxMarketOrderGas: BigNumber = BigNumber.from(MAX_MARKET_ORDER_GAS);
    const estimation = density.isZero()
      ? maxMarketOrderGas
      : offer_gasbase.add(volume.div(density)).add(maxGasreqOffer);

    if (estimation.lt(maxMarketOrderGas)) return estimation;

    return maxMarketOrderGas;
  }

  /**
   * Volume estimator.
   *
   * if you say `estimateVolume({given:100,what:"base",to:"buy"})`,
   *
   * it will give you an estimate of how much quote token you would have to
   * spend to get 100 base tokens.
   *
   * if you say `estimateVolume({given:10,what:"quote",to:"sell"})`,
   *
   * it will given you an estimate of how much base tokens you'd have to buy in
   * order to spend 10 quote tokens.
   * */
  async estimateVolume(
    params: Market.VolumeParams
  ): Promise<Market.VolumeEstimate> {
    if (
      (params.what === "base" && params.to === "buy") ||
      (params.what === "quote" && params.to === "sell")
    ) {
      return await this.#asksSemibook.estimateVolume(params);
    } else {
      return await this.#bidsSemibook.estimateVolume(params);
    }
  }

  /* Convenience method: estimate volume to be received given an amount of base/quote you are ready to spend. */
  async estimateVolumeToReceive(
    params: Market.DirectionlessVolumeParams
  ): Promise<Market.VolumeEstimate> {
    return this.estimateVolume({ ...params, to: "sell" });
  }

  /* Convenience method: estimate volume to be spent given an amount of base/quote you want to receive. */
  async estimateVolumeToSpend(
    params: Market.DirectionlessVolumeParams
  ): Promise<Market.VolumeEstimate> {
    return this.estimateVolume({ ...params, to: "buy" });
  }

  /* Convenience method to estimate volume */

  /**
   * Return config local to a market.
   * Returned object is of the form
   * {bids,asks} where bids and asks are of type `localConfig`
   * Notes:
   * Amounts are converted to plain numbers.
   * density is converted to public token units per gas used
   * fee *remains* in basis points of the token being bought
   */
  async config(): Promise<{
    asks: Mangrove.LocalConfig;
    bids: Mangrove.LocalConfig;
  }> {
    const asksConfigPromise = this.#asksSemibook.getConfig();
    const bidsConfigPromise = this.#bidsSemibook.getConfig();
    return {
      asks: await asksConfigPromise,
      bids: await bidsConfigPromise,
    };
  }

  /** Pretty prints the current state of the asks of the market */
  consoleAsks(
    filter?: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    let column = [];
    column = filter ? filter : ["id", "maker", "volume", "price"];
    this.prettyPrint("asks", column);
  }

  /** Pretty prints the current state of the bids of the market */
  consoleBids(
    filter?: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    let column = [];
    column = filter ? filter : ["id", "maker", "volume", "price"];
    this.prettyPrint("bids", column);
  }

  /** Pretty prints the current state of the asks or bids of the market */
  prettyPrint(
    ba: "bids" | "asks",
    filter: Array<
      | "id"
      | "prev"
      | "next"
      | "gasprice"
      | "maker"
      | "gasreq"
      | "overhead_gasbase"
      | "offer_gasbase"
      | "wants"
      | "gives"
      | "volume"
      | "price"
    >
  ): void {
    const offers = ba === "bids" ? this.#bidsSemibook : this.#asksSemibook;
    console.table([...offers], filter);
  }

  /**
   * Subscribe to orderbook updates.
   *
   * `cb` gets called whenever the orderbook is updated.
   *  Its first argument `event` is a summary of the event. It has the following properties:
   *
   * * `type` the type of change. May be: * `"OfferWrite"`: an offer was
   * inserted  or moved in the book.  * `"OfferFail"`, `"OfferSuccess"`,
   * `"OfferRetract"`: an offer was removed from the book because it failed,
   * succeeded, or was canceled.
   *
   * * `ba` is either `"bids"` or `"asks"`. The offer concerned by the change is
   * either an ask (an offer for `base` asking for `quote`) or a bid (`an offer
   * for `quote` asking for `base`).
   *
   * * `offer` is information about the offer, see type `Offer`.
   *
   * * `taker`, `takerWants`, `takerGives` (for `"OfferFail"` and
   * `"OfferSuccess"` only): address of the taker who executed the offer as well
   * as the volumes that were requested by the taker.
   *
   * * `mgvData` : extra data from mangrove and the maker
   * contract. See the [Mangrove contracts documentation](#TODO) for the list of possible status codes.
   *
   * `opts` may specify the maximum of offers to read initially, and the chunk
   * size used when querying the reader contract (always ran locally).
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.subscribe((event,utils) => console.log(event.type, utils.book()))
   * ```
   *
   * @note Only one subscription may be active at a time.
   */
  subscribe(cb: Market.MarketCallback<void>): void {
    this.#subscriptions.set(cb, { type: "multiple" });
  }

  /**
   *  Returns a promise which is fulfilled after execution of the callback.
   */
  async once<T>(
    cb: Market.MarketCallback<T>,
    filter?: Market.MarketFilter
  ): Promise<T> {
    return new Promise((ok, ko) => {
      const params: Market.SubscriptionParam = { type: "once", ok, ko };
      if (typeof filter !== "undefined") {
        params.filter = filter;
      }
      this.#subscriptions.set(cb as Market.StorableMarketCallback, params);
    });
  }

  /** Await until mangrove.js has processed an event that matches `filter` as
   * part of the transaction generated by `tx`. The goal is to reuse the event
   * processing facilities of market.ts as much as possible but still be
   * tx-specific (and in particular fail if the tx fails).  Alternatively one
   * could just use `await (await tx).wait(1)` but then you would not get the
   * context provided by market.ts (current position of a new offer in the OB,
   * for instance).
   *
   * Warning: if `txPromise` has already been `await`ed, its result may have
   * already been processed by the semibook event loop, so the promise will
   * never fulfill. */

  onceWithTxPromise<T>(
    txPromise: Promise<ethers.ContractTransaction>,
    cb: Market.MarketCallback<T>,
    filter?: Market.MarketFilter
  ): Promise<T> {
    return new Promise((ok, ko) => {
      const txHashDeferred = new Deferred<string>();
      const filterPromises = [];
      let someMatch = false;
      const _filter = async (
        cbArg: Market.BookSubscriptionCbArgument,
        event: Market.BookSubscriptionEvent,
        ethersEvent: ethers.ethers.providers.Log
      ) => {
        const promise = (async () => {
          const goodTx =
            (await txHashDeferred.promise) === ethersEvent.transactionHash;
          const match = filter(cbArg, event, ethersEvent) && goodTx;
          someMatch = someMatch || match;
          return match;
        })();
        filterPromises.push(promise);
        return promise;
      };
      this.once(cb, _filter).then(ok, (e) =>
        ko({ revert: false, exception: e })
      );

      txPromise.then((resp) => {
        // Warning: if the tx nor any with the same nonce is ever mined,
        // the `once` and block callbacks will never be triggered and you will memory leak by queuing tasks.
        txHashDeferred.resolve(resp.hash);
        resp
          .wait(1)
          .then((recp) => {
            this.afterBlock(recp.blockNumber, async () => {
              this.unsubscribe(cb);
              // only check if someMatch after the filters have executed:
              await Promise.all(filterPromises);
              if (!someMatch) {
                ko({
                  revert: false,
                  exception: "tx mined but filter never returned true",
                });
              }
            });
          })
          .catch((e) => {
            this.unsubscribe(cb);
            ko({ revert: true, exception: e });
          });
      });
    });
  }

  /* Stop calling a user-provided function on book-related events. */
  unsubscribe(cb: Market.StorableMarketCallback): void {
    this.#subscriptions.delete(cb);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  getOutboundInbound(ba: "bids" | "asks"): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return Market.getOutboundInbound(ba, this.base, this.quote);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  static getOutboundInbound(
    ba: "bids" | "asks",
    base: MgvToken,
    quote: MgvToken
  ): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return {
      outbound_tkn: ba === "asks" ? base : quote,
      inbound_tkn: ba === "asks" ? quote : base,
    };
  }

  /** Determine whether gives or wants will be baseVolume/quoteVolume depending on whether you're working with bids or asks. */
  static getBaseQuoteVolumes(
    ba: "asks" | "bids",
    gives: Big,
    wants: Big
  ): { baseVolume: Big; quoteVolume: Big } {
    return {
      baseVolume: ba === "asks" ? gives : wants,
      quoteVolume: ba === "asks" ? wants : gives,
    };
  }

  /** Determine the price from gives or wants depending on whether you're working with bids or asks. */
  static getPrice(ba: "asks" | "bids", gives: Big, wants: Big): Big {
    const { baseVolume, quoteVolume } = Market.getBaseQuoteVolumes(
      ba,
      gives,
      wants
    );
    return quoteVolume.div(baseVolume);
  }

  /** Determine the wants from gives and price depending on whether you're working with bids or asks. */
  static getWantsForPrice(ba: "asks" | "bids", gives: Big, price: Big): Big {
    return ba === "asks" ? gives.mul(price) : gives.div(price);
  }

  /** Determine the gives from wants and price depending on whether you're working with bids or asks. */
  static getGivesForPrice(ba: "asks" | "bids", wants: Big, price: Big): Big {
    return ba === "asks" ? wants.div(price) : wants.mul(price);
  }

  /** Determine gives and wants from a volume (in base) and a price depending on whether you're working with bids or asks. */
  static getGivesWantsForVolumeAtPrice(
    ba: "asks" | "bids",
    volume: Big,
    price: Big
  ): { gives: Big; wants: Big } {
    const gives = ba === "asks" ? volume : volume.mul(price);
    const wants = ba === "asks" ? volume.mul(price) : volume;
    return {
      gives,
      wants,
    };
  }

  /** Determine the first decimal place where the smallest price difference between neighboring offers in the order book cache is visible. */
  getDisplayDecimalsForPriceDifferences(): number {
    return Market.getDisplayDecimalsForPriceDifferences([
      ...this.#asksSemibook,
      ...[...this.#bidsSemibook].slice().reverse(),
    ]);
  }

  /** Determine the first decimal place where the smallest price difference between neighboring offers is visible. */
  static getDisplayDecimalsForPriceDifferences(offers: Market.Offer[]): number {
    if (offers.length <= 1) {
      return 0;
    }

    const absPriceDiffs = new Array<Big>(offers.length - 1);
    offers.slice(1).reduce((prevPrice, o, i) => {
      absPriceDiffs[i] = prevPrice.sub(o.price).abs();
      return o.price;
    }, offers[0].price);

    const minBig = (b1: Big, b2: Big): Big => {
      if (b1 === undefined) {
        return b2;
      } else if (b2 === undefined) {
        return b1;
      }
      return b1.lt(b2) ? b1 : b2;
    };
    const minAbsPriceDiff = absPriceDiffs
      .filter((d) => !d.eq(0))
      .reduce(minBig, undefined);

    return minAbsPriceDiff === undefined
      ? 0
      : -Math.floor(Math.log10(minAbsPriceDiff.toNumber()));
  }
}

const validateSlippage = (slippage = 0) => {
  if (typeof slippage === "undefined") {
    return 0;
  } else if (slippage > 100 || slippage < 0) {
    throw new Error("slippage should be a number between 0 and 100");
  }
  return slippage;
};

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace ThresholdBlockSubscriptions {
  export type blockSubscription = {
    seenCount: number;
    cbs: Set<(n: number) => void>;
  };
}

class ThresholdBlockSubscriptions {
  #byBlock: Map<number, ThresholdBlockSubscriptions.blockSubscription>;
  #lastSeen: number;
  #seenThreshold: number;

  constructor(lastSeen: number, seenThreshold: number) {
    this.#seenThreshold = seenThreshold;
    this.#lastSeen = lastSeen;
    this.#byBlock = new Map();
  }

  #get(n: number): ThresholdBlockSubscriptions.blockSubscription {
    return this.#byBlock.get(n) || { seenCount: 0, cbs: new Set() };
  }

  #set(n, seenCount, cbs) {
    this.#byBlock.set(n, { seenCount, cbs });
  }

  // assumes increaseCount(n) is called monotonically in n
  increaseCount(n: number): void {
    // seeing an already-seen-enough block (should not occur)
    if (n <= this.#lastSeen) {
      return;
    }

    const { seenCount, cbs } = this.#get(n);

    this.#set(n, seenCount + 1, cbs);

    // havent seen the block enough times
    if (seenCount + 1 < this.#seenThreshold) {
      return;
    }

    const prevLastSeen = this.#lastSeen;
    this.#lastSeen = n;

    // clear all past callbacks
    for (let i = prevLastSeen + 1; i <= n; i++) {
      const { cbs: _cbs } = this.#get(i);
      this.#byBlock.delete(i);
      for (const cb of _cbs) {
        cb(i);
      }
    }
  }

  subscribe<T>(n: number, cb: (number) => T): Promise<T> {
    if (this.#lastSeen >= n) {
      return Promise.resolve(cb(n));
    } else {
      const { seenCount, cbs } = this.#get(n);
      return new Promise((ok, ko) => {
        const _cb = (n) => Promise.resolve(cb(n)).then(ok, ko);
        this.#set(n, seenCount, cbs.add(_cb));
      });
    }
  }
}

export default Market;
