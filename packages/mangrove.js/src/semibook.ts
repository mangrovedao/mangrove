/**
 * Data structure for maintaining a cached prefix of an offer list for one side of a market.
 *
 * While offer lists on-chain for a market A-B are symmetric (the offer lists are
 * the same for the market B-A), a `Semibook` depends on the market:
 *
 * - Prices are in terms of quote tokens
 * - Volumes are in terms of base tokens
 * @module
 */

import { ethers, BigNumber } from "ethers";
import { Market } from ".";
import { TypedEventFilter, TypedListener } from "./types/typechain/common";
import { Deferred } from "./util";

// Guard constructor against external calls
let canConstructSemibook = false;

export class Semibook {
  readonly ba: "bids" | "asks";
  readonly market: Market;
  readonly options: Market.BookOptions;

  // TODO: Why is only the gasbase stored as part of the semibook? Why not the rest of the local configuration?
  #offer_gasbase: number;

  #initializationPromise: Promise<void>; // Resolves when initialization has completed. Used to queue events until initialization is complete.
  #canInitialize: boolean; // Guard against multiple initialization calls

  #eventFilter: TypedEventFilter<any>;
  #eventCallback: TypedListener<any>;

  // FIXME: Describe invariants
  #offers: Map<number, Market.Offer>;
  #best: number; // FIXME: 0 => empty semibook - would be better to use undefined undefined; // id of the best/first offer in the offer list iff #offers is non-empty
  #firstBlockNumber: number; // the block number that the offer list prefix is consistent with // FIXME: should not be modifiable from the outside
  // FIXME: the following are potential optimizations that can be implemented when the existing functionality has been extracted
  // #worst: number | undefined; // id of the worst/last offer in the offer list iff the whole list is in #offers; Otherwise, undefined
  // #prexixWorst: number; // id of the worst offer in #offers
  // #prefixVolume: Big; // volume of the offers in #offers

  static async connect(
    market: Market,
    ba: "bids" | "asks",
    options: Market.BookOptions
  ): Promise<Semibook> {
    canConstructSemibook = true;
    const semibook = new Semibook(market, ba, options);
    canConstructSemibook = false;
    await semibook.#initialize();
    return semibook;
  }

  /* Stop listening to events from mangrove */
  disconnect(): void {
    this.market.mgv.contract.off(this.#eventFilter, this.#eventCallback);
  }

  // FIXME: Perhaps we should provide a way to iterate over the offers instead?
  //        I'd rather not encourage users to work with the array as it has lost information
  //        about the prefix such as whether it is a true prefix or a complete offer list.
  public toArray(): Market.Offer[] {
    const result = [];

    if (this.#best !== 0) {
      // FIXME: Should test for undefined when we fix the assumption that 0 => undefined
      let latest = this.#offers.get(this.#best);
      do {
        result.push(latest);
        latest = this.#offers.get(latest.next);
      } while (latest !== undefined);
    }
    return result;
  }

  private constructor(
    market: Market,
    ba: "bids" | "asks",
    options: Market.BookOptions
  ) {
    if (!canConstructSemibook) {
      throw Error(
        "Mangrove Semibook must be initialized async with Semibook.connect (constructors cannot be async)"
      );
    }

    this.market = market;
    this.ba = ba;
    this.options = options;

    this.#canInitialize = true;

    this.#eventFilter = this.#createEventFilter();
    this.#eventCallback = (a: any) => this.#handleBookEvent(a);

    this.#offers = new Map();
    this.#best = 0; // FIXME: This should not be needed - undefined would make more sense for an empty list
  }

  async #initialize(): Promise<void> {
    if (!this.#canInitialize) return;
    this.#canInitialize = false;

    const { asks: asksConfig, bids: bidsConfig } = await this.market.config();
    const localConfig = this.ba === "bids" ? bidsConfig : asksConfig;

    this.#offer_gasbase = localConfig.offer_gasbase;

    // To avoid missing any events, we register the event listener before
    // reading the semibook. However, the events must not be processed
    // before the semibooks has been initialized. This is ensured by
    // having the event listeners await a promise that will resolve when
    // semibook reading has completed.
    const deferredInitialization = new Deferred();
    this.#initializationPromise = deferredInitialization.promise;
    this.market.mgv.contract.on(this.#eventFilter, this.#eventCallback);

    this.#firstBlockNumber = await this.market.mgv._provider.getBlockNumber();
    const offers = await this.#fetchOfferListPrefix(this.#firstBlockNumber);

    if (offers.length > 0) {
      this.#best = offers[0].id;

      for (const offer of offers) {
        this.#offers.set(offer.id, offer);
      }
    }

    deferredInitialization.resolve();
  }

  async #handleBookEvent(ethersEvent: ethers.Event): Promise<void> {
    // Book events must wait for initialization to complete
    await this.#initializationPromise;
    // If event is from firstBlockNumber (or before), ignore it as it
    // will be included in the initially read offer list
    if (ethersEvent.blockNumber <= this.#firstBlockNumber) {
      return;
    }

    const event: Market.BookSubscriptionEvent =
      this.market.mgv.contract.interface.parseLog(ethersEvent) as any;

    let offer: Market.Offer;
    let removedOffer: Market.Offer;
    let next: number;

    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );

    switch (event.name) {
      case "OfferWrite":
        // We ignore the return value here because the offer may have been outside the local
        // cache, but may now enter the local cache due to its new price.
        this.#removeOffer(event.args.id.toNumber());

        /* After removing the offer (a noop if the offer was not in local cache),
            we reinsert it.

            * The offer comes with id of its prev. If prev does not exist in cache, we skip
            the event. Note that we still want to remove the offer from the cache.
            * If the prev exists, we take the prev's next as the offer's next. Whether that next exists in the cache or not is irrelevant.
        */
        try {
          next = this.#getNextId(event.args.prev.toNumber());
        } catch (e) {
          // offer.prev was not found, we are outside local OB copy. skip.
          break;
        }

        offer = this.#toOfferObject({
          ...event.args,
          offer_gasbase: this.#offer_gasbase,
          next: BigNumber.from(next),
        });

        this.#insertOffer(offer);

        this.market.defaultCallback(
          {
            type: event.name,
            offer: offer,
            ba: this.ba,
          },
          this.ba,
          event,
          ethersEvent
        );
        break;

      case "OfferFail":
        removedOffer = this.#removeOffer(event.args.id.toNumber());
        // Don't trigger an event about an offer outside of the local cache
        if (removedOffer) {
          this.market.defaultCallback(
            {
              type: event.name,
              ba: this.ba,
              taker: event.args.taker,
              offer: removedOffer,
              takerWants: outbound_tkn.fromUnits(event.args.takerWants),
              takerGives: inbound_tkn.fromUnits(event.args.takerGives),
              mgvData: event.args.mgvData,
            },
            this.ba,
            event,
            ethersEvent
          );
        }
        break;

      case "OfferSuccess":
        removedOffer = this.#removeOffer(event.args.id.toNumber());
        if (removedOffer) {
          this.market.defaultCallback(
            {
              type: event.name,
              ba: this.ba,
              taker: event.args.taker,
              offer: removedOffer,
              takerWants: outbound_tkn.fromUnits(event.args.takerWants),
              takerGives: inbound_tkn.fromUnits(event.args.takerGives),
            },
            this.ba,
            event,
            ethersEvent
          );
        }
        break;

      case "OfferRetract":
        removedOffer = this.#removeOffer(event.args.id.toNumber());
        // Don't trigger an event about an offer outside of the local cache
        if (removedOffer) {
          this.market.defaultCallback(
            {
              type: event.name,
              ba: this.ba,
              offer: removedOffer,
            },
            this.ba,
            event,
            ethersEvent
          );
        }
        break;

      case "SetGasbase":
        this.#offer_gasbase = event.args.offer_gasbase.toNumber();
        break;
      default:
        throw Error(`Unknown event ${event}`);
    }
  }

  // Assumes ofr.prev and ofr.next are present in local OB copy.
  // Assumes id is not already in book;
  #insertOffer(offer: Market.Offer): void {
    this.#offers.set(offer.id, offer);
    if (offer.prev === 0) {
      this.#best = offer.id;
    } else {
      this.#offers.get(offer.prev).next = offer.id;
    }

    if (offer.next !== 0) {
      this.#offers.get(offer.next).prev = offer.id;
    }
  }

  // remove offer id from book and connect its prev/next.
  // return null if offer was not found in book
  #removeOffer(id: number): Market.Offer {
    const ofr = this.#offers.get(id);
    if (ofr) {
      // we differentiate prev==0 (offer is best)
      // from offers[prev] does not exist (we're outside of the local cache)
      if (ofr.prev === 0) {
        this.#best = ofr.next;
      } else {
        const prevOffer = this.#offers.get(ofr.prev);
        if (prevOffer) {
          prevOffer.next = ofr.next;
        }
      }

      // checking that nextOffers exists takes care of
      // 1. ofr.next==0, i.e. we're at the end of the book
      // 2. offers[ofr.next] does not exist, i.e. we're at the end of the local cache
      const nextOffer = this.#offers.get(ofr.next);
      if (nextOffer) {
        nextOffer.prev = ofr.prev;
      }

      this.#offers.delete(id);
      return ofr;
    } else {
      return null;
    }
    /* Insert an offer in a {offerMap,bestOffer} semibook and keep the structure in a coherent state */
  }

  // return id of offer next to offerId, according to cache.
  // note that offers[offers[offerId].next] may be not exist!
  // throws if offerId is not found
  #getNextId(offerId: number): number {
    if (offerId === 0) {
      // FIXME this is a bit weird - why should 0 mean the best?
      return this.#best;
    } else {
      if (!this.#offers.has(offerId)) {
        throw Error(
          "Trying to get next of an offer absent from local orderbook copy"
        );
      } else {
        return this.#offers.get(offerId).next;
      }
    }
  }

  /* Provides the book with raw BigNumber values */
  async #fetchOfferListPrefix(blockNumber: number): Promise<Market.Offer[]> {
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );
    // by default chunk size is number of offers desired
    const chunkSize =
      typeof this.options.chunkSize === "undefined"
        ? this.options.maxOffers
        : this.options.chunkSize;
    // save total number of offers we want
    let maxOffersLeft = this.options.maxOffers;

    let nextId = 0;

    const result: Market.Offer[] = [];
    do {
      const [_nextId, offerIds, offers, details] =
        await this.market.mgv.readerContract.offerList(
          outbound_tkn.address,
          inbound_tkn.address,
          nextId,
          chunkSize,
          { blockTag: blockNumber }
        );

      for (const [index, offerId] of offerIds.entries()) {
        result.push(
          this.#toOfferObject({
            id: offerId,
            ...offers[index],
            ...details[index],
          })
        );
      }

      nextId = _nextId.toNumber();
      maxOffersLeft = maxOffersLeft - chunkSize;
    } while (maxOffersLeft > 0 && nextId !== 0);

    return result;
  }

  #toOfferObject(raw: Market.OfferData): Market.Offer {
    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(
      this.ba
    );

    const _gives = outbound_tkn.fromUnits(raw.gives);
    const _wants = inbound_tkn.fromUnits(raw.wants);

    const { baseVolume } = this.market.getBaseQuoteVolumes(
      this.ba,
      _gives,
      _wants
    );
    const price = this.market.getPrice(this.ba, _gives, _wants);

    if (baseVolume.eq(0)) {
      throw Error("baseVolume is 0 (not allowed)");
    }

    const toNum = (i: number | BigNumber): number =>
      typeof i === "number" ? i : i.toNumber();

    return {
      id: toNum(raw.id),
      prev: toNum(raw.prev),
      next: toNum(raw.next),
      gasprice: toNum(raw.gasprice),
      maker: raw.maker,
      gasreq: toNum(raw.gasreq),
      offer_gasbase: toNum(raw.offer_gasbase),
      gives: _gives,
      wants: _wants,
      volume: baseVolume,
      price: price,
    };
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
}
