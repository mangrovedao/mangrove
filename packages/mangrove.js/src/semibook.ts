import { Big } from "big.js";
import { ethers, BigNumber } from "ethers";
import { Mangrove, Market } from ".";
import { Bigish } from "./types";
import { TypedEventFilter } from "./types/typechain/common";
import { Mutex } from "async-mutex";
import { Listener } from "@ethersproject/providers";

// Guard constructor against external calls
let canConstructSemibook = false;

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Semibook {
  export type Event = {
    cbArg: Market.BookSubscriptionCbArgument;
    event: Market.BookSubscriptionEvent;
    ethersLog: ethers.providers.Log;
  };

  export type EventListener = (e: Event) => void;
  // block listeners are called after all events have been called
  export type BlockListener = (n: number) => void;

  /**
   * Specification of how much volume to (potentially) trade on the semibook.
   *
   * `{given:100, to:"buy"}` means buying 100 base tokens.
   *
   * `{given:10, to:"sell"})` means selling 10 quote tokens.
   */
  export type VolumeParams = {
    /** Amount of token to trade. */
    given: Bigish;
    /** Whether `given` is base to be bought or quote to be sold. */
    to: "buy" | "sell";
  };

  /**
   * Options that control how the book cache behaves.
   *
   * `maxOffers` and `desiredPrice` are mutually exclusive.
   * If none of these are specfied, the default is `maxOffers` = `Semibook.DEFAULT_MAX_OFFERS`.
   */
  export type Options = {
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
     */
    desiredPrice?: Bigish;
    /**
     * The volume that is expected to be used in trades on the market.
     */
    desiredVolume?: VolumeParams;
  };

  /**
   * An iterator over a semibook cache.
   */
  export interface CacheIterator extends IterableIterator<Market.Offer> {
    /** Filter the offers in the cache using a predicate.
     *
     * @param predicate Function is a predicate, to test each element of the array.
     *   Should return `true` if the element should be kept; otherwise `false` should be returned.
     */
    filter(predicate: (offer: Market.Offer) => boolean): CacheIterator;

    /** Returns the value of the first element in the provided array that
     * satisfies the provided predicate. If no values satisfy the testing function,
     * `undefined` is returned.
     *
     * @param predicate Function is a predicate, to test each element of the array.
     *  The firs offer that satisifies the predicate is returned;
     *  otherwise `undefined` is returned.
     */
    find(predicate: (offer: Market.Offer) => boolean): Market.Offer;

    /** Returns the elements in an array. */
    toArray(): Market.Offer[];
  }
}

type RawOfferData = {
  id: BigNumber;
  prev: BigNumber;
  next: BigNumber;
  gasprice: BigNumber;
  maker: string;
  gasreq: BigNumber;
  offer_gasbase: BigNumber;
  wants: BigNumber;
  gives: BigNumber;
};

/**
 * The Semibook is a data structure for maintaining a cached prefix
 * of an offer list for one side (asks or bids) of a market.
 *
 * While offer lists on-chain for a market A-B are symmetric (the offer lists are
 * the same for the market B-A), a `Semibook` depends on the market:
 *
 * - Prices are in terms of quote tokens
 * - Volumes are in terms of base tokens
 */
// TODO: Document invariants
class Semibook implements Iterable<Market.Offer> {
  static readonly DEFAULT_MAX_OFFERS = 50;

  readonly ba: "bids" | "asks";
  readonly market: Market;
  readonly options: Semibook.Options; // complete and validated

  // TODO: Why is only the gasbase stored as part of the semibook? Why not the rest of the local configuration?
  #offer_gasbase: number;

  #canInitialize: boolean; // Guard against multiple initialization calls

  #blockEventCallback: Listener;
  #eventFilter: TypedEventFilter<any>;
  #eventListener: Semibook.EventListener;
  #blockListener: Semibook.BlockListener;

  #cacheLock: Mutex; // Lock that must be acquired when modifying the cache to ensure consistency and to queue cache updating events.
  #offerCache: Map<number, Market.Offer>; // NB: Modify only via #insertOffer and #removeOffer to ensure cache consistency
  #bestInCache: number | undefined; // id of the best/first offer in the offer list iff #offerCache is non-empty
  #worstInCache: number | undefined; // id of the worst/last offer in #offerCache
  #lastReadBlockNumber: number; // the block number that the cache is consistent with

  static async connect(
    market: Market,
    ba: "bids" | "asks",
    eventListener: Semibook.EventListener,
    blockListener: Semibook.BlockListener,
    options: Semibook.Options
  ): Promise<Semibook> {
    canConstructSemibook = true;
    const semibook = new Semibook(
      market,
      ba,
      eventListener,
      blockListener,
      options
    );
    canConstructSemibook = false;
    await semibook.#initialize();
    return semibook;
  }

  /** Stop listening to events from mangrove */
  disconnect(): void {
    this.market.mgv._provider.off("block", this.#blockEventCallback);
  }

  /* Wait until all currently pending semibook operations have been completed -- not as good as explicitly waiting for a specific tx to be processed by mangrove.js, but works as a temporary solution. Note that async-mutex's waitForUnlock is not a solution here, as it releases waiters between queue items. */
  awaitCurrentProcessing(): Promise<void> {
    return this.#cacheLock.runExclusive(() => void 0);
  }

  async requestOfferListPrefix(
    options: Semibook.Options
  ): Promise<Market.Offer[]> {
    return await this.#fetchOfferListPrefix(
      await this.market.mgv._provider.getBlockNumber(),
      undefined, // Start from best offer
      options
    );
  }

  /** Returns struct containing offer details in the current offer list */
  async offerInfo(offerId: number): Promise<Market.Offer> {
    const cachedOffer = this.#offerCache.get(offerId);
    if (cachedOffer !== undefined) {
      return cachedOffer;
    }

    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );
    const [offer, details] = await this.market.mgv.contract.offerInfo(
      outbound_tkn.address,
      inbound_tkn.address,
      offerId
    );
    return this.#rawOfferToOffer({
      id: this.#idToRawId(offerId),
      ...offer,
      ...details,
    });
  }

  /**
   * Return config local to a semibook.
   * Notes:
   * Amounts are converted to plain numbers.
   * density is converted to public token units per gas used
   * fee *remains* in basis points of the token being bought
   */
  async getConfig(blockNumber?: number): Promise<Mangrove.LocalConfig> {
    const rawConfig = await this.getRawConfig(blockNumber);
    return this.#rawConfigToConfig(rawConfig);
  }

  async getRawConfig(blockNumber?: number): Promise<Mangrove.RawConfig> {
    const { outbound_tkn, inbound_tkn } = Market.getOutboundInbound(
      this.ba,
      this.market.base,
      this.market.quote
    );
    return await this.market.mgv.contract.configInfo(
      outbound_tkn.address,
      inbound_tkn.address,
      { blockTag: blockNumber }
    );
  }

  /** Returns the number of offers in the cache. */
  size(): number {
    return this.#offerCache.size;
  }

  /** Returns the id of the best offer in the cache */
  getBestInCache(): number | undefined {
    return this.#bestInCache;
  }

  /** Returns an iterator over the offers in the cache. */
  [Symbol.iterator](): Semibook.CacheIterator {
    return new CacheIterator(this.#offerCache, this.#bestInCache);
  }

  /** Convenience method for getting an iterator without having to call `[Symbol.iterator]()`. */
  iter(): Semibook.CacheIterator {
    return this[Symbol.iterator]();
  }

  /** Given a price, find the id of the immediately-better offer in the
   * semibook. If there is no offer with a better price, `undefined` is returned.
   */
  async getPivotId(price: Bigish): Promise<number | undefined> {
    // We select as pivot the immediately-better offer.
    // The actual ordering in the offer list is lexicographic
    // price * gasreq (or price^{-1} * gasreq)
    // We ignore the gasreq comparison because we may not
    // know the gasreq (could be picked by offer contract)
    const priceAsBig = Big(price);
    const result = await this.#foldLeftUntil(
      {
        pivotFound: false,
        pivotId: undefined as number,
      },
      (accumulator) => accumulator.pivotFound,
      (offer, accumulator) => {
        if (this.isPriceWorse(offer.price, priceAsBig)) {
          accumulator.pivotFound = true;
        } else {
          accumulator.pivotId = offer.id;
        }
        return accumulator;
      }
    );
    return result.pivotId;
  }

  /**
   * Volume estimator.
   *
   * if you say `estimateVolume({given:100,to:"buy"})`,
   *
   * it will give you an estimate of how much quote token you would have to
   * spend to get 100 base tokens.
   *
   * if you say `estimateVolume({given:10,to:"sell"})`,
   *
   * it will given you an estimate of how much base tokens you'd have to buy in
   * order to spend 10 quote tokens.
   *
   * The returned `givenResidue` is how much of the given token that cannot be
   * traded due to insufficient volume on the book.
   */
  async estimateVolume(
    params: Semibook.VolumeParams
  ): Promise<Market.VolumeEstimate> {
    const TRADE_OPERATION_FILLER_DRAINER_DICT = {
      buy: { drainer: "gives", filler: "wants" },
      sell: { drainer: "wants", filler: "gives" },
    } as const;

    const { drainer, filler } = TRADE_OPERATION_FILLER_DRAINER_DICT[params.to];

    return await this.#foldLeftUntil(
      { estimatedVolume: Big(0), givenResidue: Big(params.given) },
      (accumulator) => accumulator.givenResidue.eq(0),
      (offer, accumulator) => {
        const offerDrainerVolume = offer[drainer];
        const offerVolumeDrained = accumulator.givenResidue.gt(
          offerDrainerVolume
        )
          ? offerDrainerVolume
          : accumulator.givenResidue;
        const offerFillerVolume = offer[filler];
        const offerPercentageUsed = offerVolumeDrained.div(offerDrainerVolume);
        const offerVolumeFilled = offerFillerVolume.times(offerPercentageUsed);
        accumulator.givenResidue =
          accumulator.givenResidue.minus(offerVolumeDrained);
        accumulator.estimatedVolume =
          accumulator.estimatedVolume.plus(offerVolumeFilled);
        return accumulator;
      }
    );
  }

  /** Returns `true` if `price` is better than `referencePrice`; Otherwise, `false` is returned.
   */
  isPriceBetter(price: Bigish, referencePrice: Bigish): boolean {
    const priceAsBig = Big(price);
    const referencePriceAsBig = Big(referencePrice);
    const priceComparison = this.ba === "asks" ? "lt" : "gt";
    return priceAsBig[priceComparison](referencePriceAsBig);
  }

  /** Returns `true` if `price` is worse than `referencePrice`; Otherwise, `false` is returned.
   */
  isPriceWorse(price: Bigish, referencePrice: Bigish): boolean {
    const priceAsBig = Big(price);
    const referencePriceAsBig = Big(referencePrice);
    const priceComparison = this.ba === "asks" ? "gt" : "lt";
    return priceAsBig[priceComparison](referencePriceAsBig);
  }

  async getMaxGasReq(): Promise<number | undefined> {
    // TODO: The implementation of the following predicate is work-in-progress
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const countOfferForMaxGasPredicate = (_o: Market.Offer) => true;

    const result = await this.#foldLeftUntil(
      { maxGasReq: undefined as number },
      () => {
        return false;
      },
      (cur, acc) => {
        if (countOfferForMaxGasPredicate(cur)) {
          if (acc.maxGasReq === undefined) {
            acc.maxGasReq = cur.gasreq;
          } else {
            acc.maxGasReq = Math.max(cur.gasreq, acc.maxGasReq);
          }
        }

        return acc;
      }
    );

    return result.maxGasReq;
  }

  // Fold over offers until `stopCondition` is met.
  // If cache is insufficient, fetch more offers in batches until `stopCondition` is met.
  // All fetched offers are inserted in the cache if there is room.
  async #foldLeftUntil<T>(
    accumulator: T, // NB: Must work with cloning by `Object.assign`
    stopCondition: (acc: T) => boolean,
    op: (offer: Market.Offer, acc: T) => T
  ): Promise<T> {
    // Store accumulator in case we need to rerun after locking the cache
    const originalAccumulator = accumulator;

    // Fold only on current cache
    accumulator = this.#foldLeftUntilInCache(
      Object.assign({}, originalAccumulator),
      stopCondition,
      op
    );
    if (stopCondition(accumulator)) {
      return accumulator;
    }

    // Are we certain to be at the end of the book?
    const isCacheCertainlyComplete =
      this.#offerCache.size > 0 &&
      this.#offerCache.get(this.#worstInCache).next === undefined;
    if (isCacheCertainlyComplete) {
      return accumulator;
    }

    // Either the offer list is empty or the cache is insufficient.
    // Lock the cache as we are going to fetch more offers and put them in the cache
    return await this.#cacheLock.runExclusive(async () => {
      // When the lock has been obtained, the cache may have changed,
      // so we need to restart from the beginning

      // Fold only on current cache
      accumulator = this.#foldLeftUntilInCache(
        Object.assign({}, originalAccumulator),
        stopCondition,
        op
      );
      if (stopCondition(accumulator)) {
        return accumulator;
      }

      // Are we certain to be at the end of the book?
      const isCacheCertainlyComplete =
        this.#offerCache.size > 0 &&
        this.#offerCache.get(this.#worstInCache).next === undefined;
      if (isCacheCertainlyComplete) {
        return accumulator;
      }

      // Either the offer list is still empty or the cache is still insufficient.
      // Try to fetch more offers to complete the fold
      const nextId = this.#offerCache.get(this.#worstInCache)?.next;

      await this.#fetchOfferListPrefixUntil(
        this.#lastReadBlockNumber,
        nextId,
        this.options.chunkSize,
        (chunk) => {
          for (const offer of chunk) {
            // We try to insert all the fetched offers in case the cache is not at max size
            this.#insertOffer(offer);

            // Only apply op f stop condition is _not_ met
            if (!stopCondition(accumulator)) {
              accumulator = op(offer, accumulator);
            }
          }
          return stopCondition(accumulator);
        }
      );

      return accumulator;
    });
  }

  // Fold over offers _in cache_ until `stopCondition` is met.
  #foldLeftUntilInCache<T>(
    accumulator: T,
    stopCondition: (a: T) => boolean,
    op: (offer: Market.Offer, acc: T) => T
  ): T {
    for (const offer of this) {
      accumulator = op(offer, accumulator);
      if (stopCondition(accumulator)) break;
    }
    return accumulator;
  }

  private constructor(
    market: Market,
    ba: "bids" | "asks",
    eventListener: Semibook.EventListener,
    blockListener: Semibook.BlockListener,
    options: Semibook.Options
  ) {
    if (!canConstructSemibook) {
      throw Error(
        "Mangrove Semibook must be initialized async with Semibook.connect (constructors cannot be async)"
      );
    }
    this.options = this.#setDefaultsAndValidateOptions(options);

    this.market = market;
    this.ba = ba;

    this.#canInitialize = true;
    this.#cacheLock = new Mutex();

    this.#blockEventCallback = (blockNumber: number) =>
      this.#handleBlockEvent(blockNumber);
    this.#eventListener = eventListener;
    this.#blockListener = blockListener;
    this.#eventFilter = this.#createEventFilter();

    this.#offerCache = new Map();
  }

  async #initialize(): Promise<void> {
    if (!this.#canInitialize) return;
    this.#canInitialize = false;

    // To avoid missing any blocks, we register the event listener before
    // reading the offer list. However, the events must not be processed
    // before the semibook has been initialized. This is ensured by
    // locking the cache and having the event listener await and take that lock.
    await this.#cacheLock.runExclusive(async () => {
      this.market.mgv._provider.on("block", this.#blockEventCallback);

      // To ensure consistency in this cache, everything is initially fetched from a specific block
      this.#lastReadBlockNumber =
        await this.market.mgv._provider.getBlockNumber();
      const localConfig = await this.getConfig(this.#lastReadBlockNumber);
      this.#offer_gasbase = localConfig.offer_gasbase;

      const offers = await this.#fetchOfferListPrefix(
        this.#lastReadBlockNumber
      );

      if (offers.length > 0) {
        this.#bestInCache = offers[0].id;
        this.#worstInCache = offers[offers.length - 1].id;

        for (const offer of offers) {
          this.#insertOffer(offer);
        }
      }
    });
  }

  lastReadBlockNumber(): number {
    return this.#lastReadBlockNumber;
  }

  async #handleBlockEvent(blockNumber: number): Promise<void> {
    await this.#cacheLock.runExclusive(async () => {
      // During initialization events may queue up, even some for the
      // initialization block or previous ones; These should be disregarded.
      if (blockNumber <= this.#lastReadBlockNumber) {
        return;
      }
      const logs = await this.market.mgv._provider.getLogs({
        fromBlock: blockNumber,
        toBlock: blockNumber,
        ...this.#eventFilter,
      });
      logs.forEach((l) => this.#handleBookEvent(l));
      this.#lastReadBlockNumber = blockNumber;
      this.#blockListener(this.#lastReadBlockNumber);
    });
  }

  // This modifies the cache so must be called in a context where #cacheLock is acquired
  #handleBookEvent(ethersLog: ethers.providers.Log): void {
    const event: Market.BookSubscriptionEvent =
      this.market.mgv.contract.interface.parseLog(ethersLog) as any;

    let offer: Market.Offer;
    let removedOffer: Market.Offer;
    let next: number;

    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );

    switch (event.name) {
      case "OfferWrite": {
        // We ignore the return value here because the offer may have been outside the local
        // cache, but may now enter the local cache due to its new price.
        const id = this.#rawIdToId(event.args.id);
        const prev = this.#rawIdToId(event.args.prev);
        let expectOfferInsertionInCache = true;
        this.#removeOffer(id);

        /* After removing the offer (a noop if the offer was not in local cache), we reinsert it.
         * The offer comes with id of its prev. If prev does not exist in cache, we skip
         * the event. Note that we still want to remove the offer from the cache.
         * If the prev exists, we take the prev's next as the offer's next.
         * Whether that next exists in the cache or not is irrelevant.
         */
        if (prev === undefined) {
          // The removed offer will be the best, so the next offer is the current best
          next = this.#bestInCache;
        } else if (this.#offerCache.has(prev)) {
          next = this.#offerCache.get(prev).next;
        } else {
          // offer.prev was not found, we are outside local OB copy.
          expectOfferInsertionInCache = false;
        }

        if (expectOfferInsertionInCache) {
          offer = this.#rawOfferToOffer({
            ...event.args,
            offer_gasbase: BigNumber.from(this.#offer_gasbase),
            next: this.#idToRawId(next),
          });

          if (!this.#insertOffer(offer)) {
            // Offer was not inserted
            expectOfferInsertionInCache = false;
          }
        }

        this.#eventListener({
          cbArg: {
            type: event.name,
            offer: expectOfferInsertionInCache ? offer : undefined,
            offerId: id,
            ba: this.ba,
          },
          event,
          ethersLog: ethersLog,
        });
        break;
      }

      case "OfferFail": {
        const id = this.#rawIdToId(event.args.id);
        removedOffer = this.#removeOffer(id);
        this.#eventListener({
          cbArg: {
            type: event.name,
            ba: this.ba,
            taker: event.args.taker,
            offer: removedOffer,
            offerId: id,
            takerWants: outbound_tkn.fromUnits(event.args.takerWants),
            takerGives: inbound_tkn.fromUnits(event.args.takerGives),
            mgvData: ethers.utils.parseBytes32String(event.args.mgvData),
          },
          event,
          ethersLog: ethersLog,
        });
        break;
      }

      case "OfferSuccess": {
        const id = this.#rawIdToId(event.args.id);
        removedOffer = this.#removeOffer(id);
        this.#eventListener({
          cbArg: {
            type: event.name,
            ba: this.ba,
            taker: event.args.taker,
            offer: removedOffer,
            offerId: id,
            takerWants: outbound_tkn.fromUnits(event.args.takerWants),
            takerGives: inbound_tkn.fromUnits(event.args.takerGives),
          },
          event,
          ethersLog: ethersLog,
        });
        break;
      }

      case "OfferRetract": {
        const id = this.#rawIdToId(event.args.id);
        removedOffer = this.#removeOffer(id);
        this.#eventListener({
          cbArg: {
            type: event.name,
            ba: this.ba,
            offerId: id,
            offer: removedOffer,
          },
          event,
          ethersLog: ethersLog,
        });
        break;
      }

      case "SetGasbase":
        this.#offer_gasbase = event.args.offer_gasbase.toNumber();
        break;
      default:
        throw Error(`Unknown event ${event}`);
    }
  }

  // Assumes id is not already in the cache
  // Returns `true` if the offer was inserted into the cache; Otherwise, `false`.
  // This modifies the cache so must be called in a context where #cacheLock is acquired
  #insertOffer(offer: Market.Offer): boolean {
    // Only insert offers that are extensions of the cache
    if (offer.prev !== undefined && !this.#offerCache.has(offer.prev)) {
      return false;
    }

    this.#offerCache.set(offer.id, offer);

    if (offer.prev === undefined) {
      this.#bestInCache = offer.id;
    } else {
      this.#offerCache.get(offer.prev).next = offer.id;
    }

    if (offer.prev === this.#worstInCache) {
      this.#worstInCache = offer.id;
    }

    const nextOffer = this.#offerCache.get(offer.next);
    if (nextOffer !== undefined) {
      nextOffer.prev = offer.id;
    }

    // If maxOffers option has been specified, evict worst offer if over max size
    if (
      this.options.maxOffers !== undefined &&
      this.#offerCache.size > this.options.maxOffers
    ) {
      const removedOffer = this.#removeOffer(this.#worstInCache);
      if (offer.id === removedOffer?.id) {
        return false;
      }
    }
    return true;
  }

  // remove offer id from book and connect its prev/next.
  // return 'undefined' if offer was not found in book
  // This modifies the cache so must be called in a context where #cacheLock is acquired
  #removeOffer(id: number): Market.Offer {
    const offer = this.#offerCache.get(id);
    if (offer === undefined) return undefined;

    if (offer.prev === undefined) {
      this.#bestInCache = offer.next;
    } else {
      this.#offerCache.get(offer.prev).next = offer.next;
    }

    const nextOffer = this.#offerCache.get(offer.next);
    if (nextOffer === undefined) {
      this.#worstInCache = offer.prev;
    } else {
      nextOffer.prev = offer.prev;
    }

    this.#offerCache.delete(id);
    return offer;
  }

  /** Fetches offers from the network.
   *
   * If options are given, those are used instead of the options
   * given when constructing the Semibook.
   */
  async #fetchOfferListPrefix(
    blockNumber: number,
    fromId?: number,
    options?: Semibook.Options
  ): Promise<Market.Offer[]> {
    options = this.#setDefaultsAndValidateOptions(options ?? this.options);

    if (options.desiredPrice !== undefined) {
      return await this.#fetchOfferListPrefixUntil(
        blockNumber,
        fromId,
        options.chunkSize,
        (chunk) =>
          chunk.length === 0
            ? true
            : this.isPriceBetter(
                options.desiredPrice,
                chunk[chunk.length - 1].price
              )
      );
    } else if (options.desiredVolume !== undefined) {
      const filler = options.desiredVolume.to === "buy" ? "gives" : "wants";
      let volume = Big(0);
      return await this.#fetchOfferListPrefixUntil(
        blockNumber,
        fromId,
        options.chunkSize,
        (chunk) => {
          chunk.forEach((offer) => {
            volume = volume.plus(offer[filler]);
          });
          return volume.gte(options.desiredVolume.given);
        }
      );
    } else {
      return await this.#fetchOfferListPrefixUntil(
        blockNumber,
        fromId,
        options.chunkSize,
        (chunk, allFetched) => allFetched.length >= options.maxOffers
      );
    }
  }

  /** Fetches offers from the network until a condition is met. */
  async #fetchOfferListPrefixUntil(
    blockNumber: number,
    fromId: number,
    chunkSize: number,
    processChunk: (chunk: Market.Offer[], allFetched: Market.Offer[]) => boolean // Should return `true` when fetching should stop
  ): Promise<Market.Offer[]> {
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );

    let chunk: Market.Offer[];
    const result: Market.Offer[] = [];
    do {
      const [_nextId, offerIds, offers, details] =
        await this.market.mgv.readerContract.offerList(
          outbound_tkn.address,
          inbound_tkn.address,
          this.#idToRawId(fromId),
          chunkSize,
          { blockTag: blockNumber }
        );

      chunk = offerIds.map((offerId, index) =>
        this.#rawOfferToOffer({
          id: offerId,
          ...offers[index],
          ...details[index],
        })
      );

      result.push(...chunk);

      fromId = this.#rawIdToId(_nextId);
    } while (!processChunk(chunk, result) && fromId !== undefined);

    return result;
  }

  #rawConfigToConfig(cfg: Mangrove.RawConfig): Mangrove.LocalConfig {
    const { outbound_tkn } = this.market.getOutboundInbound(this.ba);
    return {
      active: cfg.local.active,
      fee: cfg.local.fee.toNumber(),
      density: outbound_tkn.fromUnits(cfg.local.density),
      offer_gasbase: cfg.local.offer_gasbase.toNumber(),
      lock: cfg.local.lock,
      best: this.#rawIdToId(cfg.local.best),
      last: this.#rawIdToId(cfg.local.last),
    };
  }

  #rawOfferToOffer(raw: RawOfferData): Market.Offer {
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );

    const _gives = outbound_tkn.fromUnits(raw.gives);
    const _wants = inbound_tkn.fromUnits(raw.wants);

    const { baseVolume } = Market.getBaseQuoteVolumes(this.ba, _gives, _wants);
    const price = Market.getPrice(this.ba, _gives, _wants);

    if (baseVolume.eq(0)) {
      throw Error("baseVolume is 0 (not allowed)");
    }

    return {
      id: this.#rawIdToId(raw.id),
      prev: this.#rawIdToId(raw.prev),
      next: this.#rawIdToId(raw.next),
      gasprice: raw.gasprice.toNumber(),
      maker: raw.maker,
      gasreq: raw.gasreq.toNumber(),
      offer_gasbase: raw.offer_gasbase.toNumber(),
      gives: _gives,
      wants: _wants,
      volume: baseVolume,
      price: price,
    };
  }

  #rawIdToId(rawId: BigNumber): number | undefined {
    const id = rawId.toNumber();
    return id === 0 ? undefined : id;
  }

  #idToRawId(id: number | undefined): BigNumber {
    return id === undefined ? BigNumber.from(0) : BigNumber.from(id);
  }

  #createEventFilter(): TypedEventFilter<any> {
    /* Disjunction of possible event names */
    const topics0 = [
      "OfferSuccess",
      "OfferFail",
      "OfferWrite",
      "OfferRetract",
      "SetGasbase",
    ].map((e) =>
      this.market.mgv.contract.interface.getEventTopic(
        this.market.mgv.contract.interface.getEvent(e as any)
      )
    );

    const base_padded = ethers.utils.hexZeroPad(this.market.base.address, 32);
    const quote_padded = ethers.utils.hexZeroPad(this.market.quote.address, 32);

    const topics =
      this.ba === "asks"
        ? [topics0, base_padded, quote_padded]
        : [topics0, quote_padded, base_padded];

    return {
      address: this.market.mgv._address,
      topics: topics,
    };
  }

  #setDefaultsAndValidateOptions(options: Semibook.Options): Semibook.Options {
    const result = Object.assign({}, options);

    const countCacheContentOptions =
      (options.maxOffers !== undefined ? 1 : 0) +
      (options.desiredPrice !== undefined ? 1 : 0) +
      (options.desiredVolume !== undefined ? 1 : 0);
    if (countCacheContentOptions > 1) {
      throw Error(
        "Only one of maxOffers, desiredPrice, and desiredVolume can be specified"
      );
    }

    if (options.maxOffers !== undefined && options.maxOffers < 0) {
      throw Error("Semibook options.maxOffers must be >= 0");
    }

    if (result.chunkSize === undefined) {
      result.chunkSize =
        result.maxOffers !== undefined && result.maxOffers > 0
          ? result.maxOffers
          : Semibook.DEFAULT_MAX_OFFERS;
    }
    if (options.chunkSize <= 0) {
      throw Error("Semibook options.chunkSize must be > 0");
    }
    return result;
  }
}

class CacheIterator implements Semibook.CacheIterator {
  #offerCache: Map<number, Market.Offer>;
  #latest: number;
  #predicate: (offer: Market.Offer) => boolean;

  constructor(
    offerCache: Map<number, Market.Offer>,
    bestInCache: number,
    predicate: (offer: Market.Offer) => boolean = () => true
  ) {
    this.#offerCache = offerCache;
    this.#latest = bestInCache;
    this.#predicate = predicate;
  }

  [Symbol.iterator](): Semibook.CacheIterator {
    return this;
  }

  next() {
    let value: Market.Offer;
    do {
      value =
        this.#latest === undefined
          ? undefined
          : this.#offerCache.get(this.#latest);
      this.#latest = value?.next;
    } while (
      value !== undefined &&
      this.#predicate !== undefined &&
      !this.#predicate(value)
    );
    return {
      done: value === undefined,
      value: value,
    };
  }

  filter(predicate: (offer: Market.Offer) => boolean): Semibook.CacheIterator {
    return new CacheIterator(
      this.#offerCache,
      this.#latest,
      (o) => this.#predicate(o) && predicate(o)
    );
  }

  find(predicate: (offer: Market.Offer) => boolean): Market.Offer {
    for (const element of this) {
      if (predicate(element)) {
        return element;
      }
    }
    return undefined;
  }

  toArray(): Market.Offer[] {
    return [...this];
  }
}

export default Semibook;
