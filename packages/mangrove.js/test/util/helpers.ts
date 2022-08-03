import { BigNumber, BigNumberish, ContractTransaction, utils } from "ethers";
import Mangrove, { MgvToken } from "../../src";

export const sleep = (ms?: number): Promise<void> => {
  return new Promise((cb) => setTimeout(cb, ms));
};

export type AsyncQueue<T> = {
  put: (e: T) => void;
  get: () => Promise<T>;
};

export const asyncQueue = <T>(): AsyncQueue<T> => {
  const promises = [],
    elements = [];
  return {
    put: (elem) => {
      if (promises.length > 0) {
        promises.shift()(elem);
      } else {
        elements.push(elem);
      }
    },
    get: () => {
      if (elements.length > 0) {
        return Promise.resolve(elements.shift());
      } else {
        return new Promise((ok) => promises.push(ok));
      }
    },
  };
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const toWei = (v: string | number, u = "ether"): BigNumber =>
  utils.parseUnits(v.toString(), u);

export const approxEq = (
  a: BigNumberish,
  b: BigNumberish,
  delta: string
): boolean => {
  // const aa = BigNumber.from(a);
  // const bb = BigNumber.from(b);
  // if (aa.lt(bb)) {
  //   return aa.sub(bb).lte(toWei(delta));
  // } else {
  //   return bb.sub(aa).lte(toWei(delta));
  // }
  return BigNumber.from(a).sub(b).abs().lte(toWei(delta));
};

export type OfferData = {
  wants: string;
  gives: string;
  gasreq?: BigNumberish;
  gasprice?: BigNumberish;
};

export const newOffer = (
  mgv: Mangrove,
  base: string | MgvToken,
  quote: string | MgvToken,
  { wants, gives, gasreq, gasprice }: OfferData
): Promise<ContractTransaction> => {
  const baseAddress =
    typeof base === "string" ? mgv.getAddress(base) : base.address;
  const quoteAddress =
    typeof quote === "string" ? mgv.getAddress(quote) : quote.address;
  return mgv.contract.newOffer(
    baseAddress,
    quoteAddress,
    toWei(wants),
    toWei(gives),
    gasreq || 10000,
    gasprice || 1,
    0
  );
};
