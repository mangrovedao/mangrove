import { logger, logdataLimiter } from "./util/logger";
import pick from "object.pick";
import {
  addresses,
  decimals as loadedDecimals,
  displayedDecimals as loadedDisplayedDecimals,
  defaultDisplayedDecimals,
  displayedPriceDecimals as loadedDisplayedPriceDecimals,
  defaultDisplayedPriceDecimals,
} from "./constants";
import * as eth from "./eth";
import { getAllToyENSEntries } from "./util/testServer";
import { typechain, Provider, Signer } from "./types";
import { Bigish } from "./types";
import { LiquidityProvider, OfferLogic, MgvToken, Market } from ".";

import Big from "big.js";
// Configure big.js global constructor
Big.DP = 20; // precision when dividing
Big.RM = Big.roundHalfUp; // round to nearest

import * as ethers from "ethers";
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] =
  Big.prototype.toString;

/* Prevent directly calling Mangrove constructor
   use Mangrove.connect to make sure the network is reached during construction */
let canConstructMangrove = false;

import type { Awaited } from "ts-essentials";
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Mangrove {
  export type RawConfig = Awaited<
    ReturnType<typechain.Mangrove["functions"]["configInfo"]>
  >;

  export type LocalConfig = {
    active: boolean;
    fee: number;
    density: Big;
    offer_gasbase: number;
    lock: boolean;
    best: number | undefined;
    last: number | undefined;
  };

  export type GlobalConfig = {
    monitor: string;
    useOracle: boolean;
    notify: boolean;
    gasprice: number;
    gasmax: number;
    dead: boolean;
  };
}

class Mangrove {
  _provider: Provider;
  _signer: Signer;
  _network: eth.ProviderNetwork;
  _readOnly: boolean;
  _address: string;
  contract: typechain.Mangrove;
  readerContract: typechain.MgvReader;
  cleanerContract: typechain.MgvCleaner;
  // NB: We currently use MangroveOrderEnriched instead of MangroveOrder, see https://github.com/mangrovedao/mangrove/issues/535
  // orderContract: typechain.MangroveOrder;
  orderContract: typechain.MangroveOrderEnriched;
  static typechain = typechain;
  static addresses = addresses;
  static decimals = loadedDecimals;

  /**
   * Creates an instance of the Mangrove Typescript object
   *
   * @param {object} [options] Optional provider options.
   *
   * @example
   * ```
   * const mgv = await require('mangrove.js').connect(options); // web browser
   * ```
   *
   * if options is a string `s`, it is considered to be {provider:s}
   * const mgv = await require('mangrove.js').connect('http://127.0.0.1:8545'); // HTTP provider
   *
   * Options:
   * * privateKey: `0x...`
   * * mnemonic: `horse battery ...`
   * * path: `m/44'/60'/0'/...`
   * * provider: url, provider object, or chain string
   *
   * @returns {Mangrove} Returns an instance mangrove.js
   */

  static async connect(
    options: eth.CreateSignerOptions | string = {}
  ): Promise<Mangrove> {
    if (typeof options === "string") {
      options = { provider: options };
    }

    const { readOnly, signer } = await eth._createSigner(options); // returns a provider equipped signer
    const network = await eth.getProviderNetwork(signer.provider);
    if (network.name === "local" && !Mangrove.addresses[network.name]) {
      Mangrove.fetchAllAddresses(signer.provider);
    }
    canConstructMangrove = true;
    const mgv = new Mangrove({
      signer: signer,
      network: network,
      readOnly,
    });
    canConstructMangrove = false;

    logger.debug("Initialize Mangrove", {
      contextInfo: "mangrove.base",
      data: logdataLimiter({
        signer: signer,
        network: network,
        readOnly: readOnly,
      }),
    });

    return mgv;
  }

  disconnect(): void {
    this._provider.removeAllListeners();

    logger.debug("Disconnect from Mangrove", {
      contextInfo: "mangrove.base",
    });
  }
  //TODO types in module namespace with same name as class
  //TODO remove _prefix on public properties

  constructor(params: {
    signer: Signer;
    network: eth.ProviderNetwork;
    readOnly: boolean;
  }) {
    if (!canConstructMangrove) {
      throw Error(
        "Mangrove.js must be initialized async with Mangrove.connect (constructors cannot be async)"
      );
    }
    // must always pass a provider-equipped signer
    this._provider = params.signer.provider;
    this._signer = params.signer;
    this._network = params.network;
    this._readOnly = params.readOnly;
    this._address = Mangrove.getAddress("Mangrove", this._network.name);
    this.contract = typechain.Mangrove__factory.connect(
      this._address,
      this._signer
    );
    const readerAddress = Mangrove.getAddress("MgvReader", this._network.name);
    this.readerContract = typechain.MgvReader__factory.connect(
      readerAddress,
      this._signer
    );
    const cleanerAddress = Mangrove.getAddress(
      "MgvCleaner",
      this._network.name
    );
    this.cleanerContract = typechain.MgvCleaner__factory.connect(
      cleanerAddress,
      this._signer
    );
    // NB: We currently use MangroveOrderEnriched instead of MangroveOrder, see https://github.com/mangrovedao/mangrove/issues/535
    const orderAddress = Mangrove.getAddress(
      // "MangroveOrder",
      "MangroveOrderEnriched",
      this._network.name
    );
    // this.orderContract = typechain.MangroveOrder__factory.connect(
    this.orderContract = typechain.MangroveOrderEnriched__factory.connect(
      orderAddress,
      this._signer
    );
  }
  /* Instance */
  /************** */

  /* Get Market object.
     Argument of the form `{base,quote}` where each is a string.
     To set your own token, use `setDecimals` and `setAddress`.
  */
  async market(params: {
    base: string;
    quote: string;
    bookOptions?: Market.BookOptions;
  }): Promise<Market> {
    logger.debug("Initialize Market", {
      contextInfo: "mangrove.base",
      data: pick(params, ["base", "quote", "bookOptions"]),
    });
    return await Market.connect({ ...params, mgv: this });
  }

  /** Get an OfferLogic object allowing one to monitor and set up an onchain offer logic*/
  offerLogic(logic: string, multiMaker?: boolean): OfferLogic {
    if (ethers.utils.isAddress(logic)) {
      return new OfferLogic(this, logic, multiMaker ? multiMaker : false);
    } else {
      // loading a multi maker predeployed logic
      const address: string = Mangrove.getAddress(logic, this._network.name);
      if (address) {
        return new OfferLogic(this, address, true);
      } else {
        throw Error(`Cannot find ${logic} on network ${this._network.name}`);
      }
    }
  }

  /** Get a LiquidityProvider object to enable Mangrove's signer to pass buy and sell orders*/
  async liquidityProvider(
    p:
      | Market
      | {
          base: string;
          quote: string;
          bookOptions?: Market.BookOptions;
        }
  ): Promise<LiquidityProvider> {
    const EOA = await this._signer.getAddress();
    if (p instanceof Market) {
      return new LiquidityProvider({
        mgv: this,
        eoa: EOA,
        market: p,
      });
    } else {
      return new LiquidityProvider({
        mgv: this,
        eoa: EOA,
        market: await this.market(p),
      });
    }
  }

  /* Return MgvToken instance tied. */
  token(name: string): MgvToken {
    return new MgvToken(name, this);
  }

  /**
   * Read a contract address on the current network.
   *
   * Note that this reads from the static `Mangrove` address registry which is shared across instances of this class.
   */
  getAddress(name: string): string {
    return Mangrove.getAddress(name, this._network.name || "mainnet");
  }

  /**
   * Set a contract address on the current network.
   *
   * Note that this writes to the static `Mangrove` address registry which is shared across instances of this class.
   */
  setAddress(name: string, address: string): void {
    Mangrove.setAddress(name, address, this._network.name || "mainnet");
  }

  /** Convert public token amount to internal token representation.
   *
   * if `nameOrDecimals` is a string, it is interpreted as a token name. Otherwise
   * it is the number of decimals.
   *
   *  @example
   *  ```
   *  mgv.toUnits(10,"USDC") // 10e6 as ethers.BigNumber
   *  mgv.toUnits(10,6) // 10e6 as ethers.BigNumber
   *  ```
   */
  toUnits(amount: Bigish, nameOrDecimals: string | number): ethers.BigNumber {
    let decimals;
    if (typeof nameOrDecimals === "number") {
      decimals = nameOrDecimals;
    } else {
      decimals = Mangrove.getDecimals(nameOrDecimals);
    }
    return ethers.BigNumber.from(Big(10).pow(decimals).mul(amount).toFixed(0));
  }

  /** Convert internal token amount to public token representation.
   *
   * if `nameOrDecimals` is a string, it is interpreted as a token name. Otherwise
   * it is the number of decimals.
   *
   *  @example
   *  ```
   *  mgv.fromUnits("1e19","DAI") // 10
   *  mgv.fromUnits("1e19",18) // 10
   *  ```
   */
  fromUnits(
    amount: number | string | ethers.BigNumber,
    nameOrDecimals: string | number
  ): Big {
    let decimals;
    if (typeof nameOrDecimals === "number") {
      decimals = nameOrDecimals;
    } else {
      decimals = Mangrove.getDecimals(nameOrDecimals);
    }
    if (amount instanceof ethers.BigNumber) {
      amount = amount.toString();
    }
    return Big(amount).div(Big(10).pow(decimals));
  }

  /** Provision available at mangrove for address given in argument, in ethers */
  async balanceOf(
    address: string,
    overrides: ethers.Overrides = {}
  ): Promise<Big> {
    const bal = await this.contract.balanceOf(address, overrides);
    return this.fromUnits(bal, 18);
  }

  fundMangrove(
    amount: Bigish,
    maker: string,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    const _overrides = { value: this.toUnits(amount, 18), ...overrides };
    return this.contract["fund(address)"](maker, _overrides);
  }

  withdraw(
    amount: Bigish,
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.contract.withdraw(this.toUnits(amount, 18), overrides);
  }

  approveMangrove(
    tokenName: string,
    arg: { amount?: Bigish } = {},
    overrides: ethers.Overrides = {}
  ): Promise<ethers.ContractTransaction> {
    return this.token(tokenName).approveMangrove(arg, overrides);
  }

  /**
   * Return global Mangrove config
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async config(): Promise<Mangrove.GlobalConfig> {
    const config = await this.contract.configInfo(
      ethers.constants.AddressZero,
      ethers.constants.AddressZero
    );
    return {
      monitor: config.global.monitor,
      useOracle: config.global.useOracle,
      notify: config.global.notify,
      gasprice: config.global.gasprice.toNumber(),
      gasmax: config.global.gasmax.toNumber(),
      dead: config.global.dead,
    };
  }

  /* Static */
  /********** */

  /**
   * Read all contract addresses on the given network.
   */
  static getAllAddresses(network: string): [string, string][] {
    if (!addresses[network]) {
      throw Error(`No addresses for network ${network}.`);
    }

    return Object.entries(Mangrove.addresses[network]);
  }

  /**
   * Read a contract address on a given network.
   */
  static getAddress(name: string, network: string): string {
    if (!Mangrove.addresses[network]) {
      throw Error(`No addresses for network ${network}.`);
    }

    if (!Mangrove.addresses[network][name]) {
      throw Error(`No address for ${name} on network ${network}.`);
    }

    return Mangrove.addresses[network]?.[name] as string;
  }

  /**
   * Set a contract address on the given network.
   */
  static setAddress(name: string, address: string, network: string): void {
    if (!Mangrove.addresses[network]) {
      Mangrove.addresses[network] = {};
    }
    Mangrove.addresses[network][name] = address;
  }

  /**
   * Read decimals for `tokenName` on given network.
   * To read decimals directly onchain, use `fetchDecimals`.
   */
  static getDecimals(tokenName: string): number {
    if (typeof Mangrove.decimals[tokenName] !== "number") {
      throw Error(`No decimals on record for token ${tokenName}`);
    }

    return Mangrove.decimals[tokenName] as number;
  }

  /**
   * Read displayed decimals for `tokenName`.
   */
  static getDisplayedDecimals(tokenName: string): number {
    return loadedDisplayedDecimals[tokenName] || defaultDisplayedDecimals;
  }

  /**
   * Read displayed decimals for `tokenName` when displayed as a price.
   */
  static getDisplayedPriceDecimals(tokenName: string): number {
    return (
      loadedDisplayedPriceDecimals[tokenName] || defaultDisplayedPriceDecimals
    );
  }

  /**
   * Set decimals for `tokenName` on current network.
   */
  static setDecimals(tokenName: string, dec: number): void {
    Mangrove.decimals[tokenName] = dec;
  }

  /**
   * Set displayed decimals for `tokenName`.
   */
  static setDisplayedDecimals(tokenName: string, dec: number): void {
    loadedDisplayedDecimals[tokenName] = dec;
  }

  /**
   * Set displayed decimals for `tokenName` when displayed as a price.
   */
  static setDisplayedPriceDecimals(tokenName: string, dec: number): void {
    loadedDisplayedPriceDecimals[tokenName] = dec;
  }

  /**
   * Read chain for decimals of `tokenName` on current network and save them
   */
  static async fetchDecimals(
    tokenName: string,
    provider: Provider
  ): Promise<number> {
    const network = await eth.getProviderNetwork(provider);
    const token = typechain.IERC20__factory.connect(
      Mangrove.getAddress(tokenName, network.name),
      provider
    );
    const decimals = await token.decimals();
    this.setDecimals(tokenName, decimals);
    return decimals;
  }

  /**
   * Returns all addresses registered at the local server's Toy ENS contract.
   * Assumes provider is connected to a local server (typically for testing/experimentation).
   */
  static async fetchAllAddresses(provider: ethers.providers.Provider) {
    const network = await eth.getProviderNetwork(provider);
    try {
      const contracts = await getAllToyENSEntries(provider);
      for (const { name, address, isToken } of contracts) {
        Mangrove.setAddress(name, address, network.name);
        if (isToken) {
          Mangrove.fetchDecimals(name, provider);
        }
      }
    } catch (err) {}
  }
}

export default Mangrove;
