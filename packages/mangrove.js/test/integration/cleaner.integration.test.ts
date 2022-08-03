// Integration tests for Cleaner.ts
import { describe } from "mocha";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);

import Mangrove from "../../src";

import { Big } from "big.js";
//pretty-print when using console.log
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] = function () {
  return `<Big>${this.toString()}`; // previously just Big.prototype.toString;
};

describe("Cleaner integration tests suite", () => {
  let mgv: Mangrove;

  beforeEach(async function () {
    //set mgv object
    mgv = await Mangrove.connect({
      provider: this.server.url,
      privateKey: this.accounts.tester.key,
    });

    // Shorten polling for faster tests
    // Workaround for the fact that Ethers.js does not expose Provider.pollingInterval in its type declarations
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    mgv._provider.pollingInterval = 10;
  });

  afterEach(async () => {
    mgv.disconnect();
  });

  // FIXME temporarily disable
  // it("cannot approve Mangrove from non-admin account", async function () {
  //   const tokenB = await mgv.token("TokenB");

  //     // FIXME rewrite to use Mangrove API
  //     expect(
  //       mgv.cleanerContract.approveMgv(tokenB.address, tokenB.toUnits(10))
  //     ).to.eventually.throw("AccessControlled/Invalid");
  // });

  // TODO test other Cleaner functions
});
