import { logger } from "./util/logger";
import Mangrove from "@mangrovedao/mangrove.js";
import Big from "big.js";
import get from "axios";
import * as typechain from "./types/typechain";

/**
 * Configuration for an external oracle JSON REST endpoint.
 * @param oracleEndpointURL URL for the external oracle - expects a JSON REST endpoint.
 * @param oracleEndpointKey Name of key to lookup in JSON returned by JSON REST endpoint.
 */
type OracleEndpointConfiguration = {
  readonly _tag: "Endpoint";
  readonly oracleEndpointURL: string;
  readonly oracleEndpointKey: string;
};

/**
 * @param OracleGasPrice A constant gasprice to be returned by this bot.
 */
type ConstantOracleConfiguration = {
  readonly _tag: "Constant";
  readonly OracleGasPrice: number;
};

/**
 * An oracle source configuration - should be either a constant gas price
 * oracle or the url of an external oracle (a JSON REST endpoint) and the key
 * to lookup in the JSON returned by the endpoint.
 */
export type OracleSourceConfiguration =
  | ConstantOracleConfiguration
  | OracleEndpointConfiguration;

/**
 * A GasUpdater bot, which queries an external oracle for gas prices, and sends
 * gas price updates to Mangrove, through a dedicated oracle contract.
 */
export class GasUpdater {
  #mangrove: Mangrove;
  #acceptableGasGapToOracle: number;
  #constantOracleGasPrice: number | undefined;
  #oracleURL = "";
  #oracleURL_Key = "";
  oracleContract: typechain.MgvOracle;

  /**
   * Constructs a GasUpdater bot.
   * @param mangrove A mangrove.js Mangrove object.
   * @param acceptableGasGapToOracle The allowed gap between the Mangrove gas
   * price and the external oracle gas price.
   * @param oracleSourceConfiguration The oracle source configuration - see type `OracleSourceConfiguration`.
   */
  constructor(
    mangrove: Mangrove,
    acceptableGasGapToOracle: number,
    oracleSourceConfiguration: OracleSourceConfiguration
  ) {
    this.#mangrove = mangrove;
    this.#acceptableGasGapToOracle = acceptableGasGapToOracle;

    switch (oracleSourceConfiguration._tag) {
      case "Constant":
        this.#constantOracleGasPrice = oracleSourceConfiguration.OracleGasPrice;
        break;
      case "Endpoint":
        this.#oracleURL = oracleSourceConfiguration.oracleEndpointURL;
        this.#oracleURL_Key = oracleSourceConfiguration.oracleEndpointKey;
        break;
      default:
        throw new Error(
          `Parameter oracleSourceConfiguration must be either ConstantOracleConfiguration or OracleEndpointConfiguration. Found '${oracleSourceConfiguration}'`
        );
    }
    // Using the mangrove.js address functionallity, since there is no reason to recreate the significant infastructure for only one Contract.
    const oracleAddress = Mangrove.getAddress(
      "MgvOracle",
      mangrove._network.name
    );
    this.oracleContract = typechain.MgvOracle__factory.connect(
      oracleAddress,
      mangrove._signer
    );
  }

  /**
   * Checks an external oracle for an updated gas price, compares with the
   * current Mangrove gas price and, if deemed necessary, sends an updated
   * gas price to use to the oracle contract, which this bot works together
   * with.
   */
  public async checkSetGasprice(): Promise<void> {
    //NOTE: Possibly suitable protection against reentrancy

    logger.info(`Checking whether Mangrove gas price needs updating...`);

    const globalConfig = await this.#mangrove.config();
    if (globalConfig.dead) {
      logger.error("`Mangrove is dead, skipping update.");
      return;
    }

    logger.debug("Mangrove global config retrieved", { data: globalConfig });

    const currentMangroveGasPrice = globalConfig.gasprice;

    const oracleGasPriceEstimate = await this.#getGasPriceEstimateFromOracle();

    if (oracleGasPriceEstimate !== undefined) {
      const [shouldUpdateGasPrice, newGasPrice] =
        this.#shouldUpdateMangroveGasPrice(
          currentMangroveGasPrice,
          oracleGasPriceEstimate
        );

      if (shouldUpdateGasPrice) {
        logger.debug(`Determined gas price update needed. `, {
          data: newGasPrice,
        });
        await this.#updateMangroveGasPrice(newGasPrice);
      } else {
        logger.debug(`Determined gas price update not needed.`);
      }
    } else {
      const url = this.#oracleURL;
      const key = this.#oracleURL_Key;
      logger.error(
        "Error getting gas price from oracle endpoint, skipping update. Oracle endpoint config:",
        { data: { url, key } }
      );
    }
  }

  /**
   * Either returns a constant gas price, if set, or queries a dedicated
   * external source for gas prices.
   * @returns {number} Promise object representing the gas price from the
   * external oracle
   */
  async #getGasPriceEstimateFromOracle(): Promise<number | undefined> {
    if (this.#constantOracleGasPrice !== undefined) {
      logger.debug(
        `'constantOracleGasPrice' set. Using the configured value.`,
        { data: this.#constantOracleGasPrice }
      );
      return this.#constantOracleGasPrice;
    }

    try {
      const { data } = await get(this.#oracleURL);
      logger.debug(`Received this data from oracle.`, { data: data });
      return data[this.#oracleURL_Key];
    } catch (error) {
      logger.error("Getting gas price estimate from oracle failed", {
        mangrove: this.#mangrove,
        data: error,
      });
    }
  }

  /**
   * Compare the current Mangrove gasprice with a gas price from the external
   * oracle, and decide whether a gas price update should be sent.
   * @param currentGasPrice Current gas price from Mangrove config.
   * @param oracleGasPrice Gas price from external oracle.
   * @returns {[boolean, number]} A pair representing (1) whether the Mangrove
   * gas price should be updated, and (2) what gas price to update to.
   */
  #shouldUpdateMangroveGasPrice(
    currentGasPrice: number,
    oracleGasPrice: number
  ): [boolean, number] {
    //NOTE: Very basic implementation allowing a configurable gap between
    //      Mangrove an oracle gas price.
    const shouldUpdate =
      Math.abs(currentGasPrice - oracleGasPrice) >
      this.#acceptableGasGapToOracle;

    if (shouldUpdate) {
      logger.debug(
        `shouldUpdateMangroveGasPrice: Determined update needed - to ${oracleGasPrice}`
      );
      return [true, oracleGasPrice];
    } else {
      logger.debug(
        `shouldUpdateMangroveGasPrice: Determined no update needed.`
      );
      return [false, oracleGasPrice];
    }
  }

  /**
   * Send a gas price update to the oracle contract, which Mangrove uses.
   * @param newGasPrice The new gas price.
   */
  async #updateMangroveGasPrice(newGasPrice: number): Promise<void> {
    logger.debug(
      "updateMangroveGasPrice: Sending gas update to oracle contract."
    );

    try {
      // Round to closest integer before converting to BigNumber
      const newGasPriceRounded = Math.round(newGasPrice);

      await this.oracleContract
        .setGasPrice(newGasPriceRounded)
        .then((tx) => tx.wait());

      logger.info(
        `Succesfully sent Mangrove gas price update to oracle: ${newGasPriceRounded}.`
      );
    } catch (e) {
      logger.error("setGasprice failed", {
        mangrove: this.#mangrove,
        data: e,
      });
    }
  }
}
