import { afterEach, beforeEach, describe, it } from "mocha";
import assert from "assert";
import { Mangrove } from "../../src";

import { Big } from "big.js";
//pretty-print when using console.log
Big.prototype[Symbol.for("nodejs.util.inspect.custom")] = function () {
  return `<Big>${this.toString()}`; // previously just Big.prototype.toString;
};

describe("MGV Token integration tests suite", () => {
  let mgv;

  beforeEach(async function () {
    //set mgv object
    mgv = await Mangrove.connect({
      provider: this.server.url,
      privateKey: this.accounts.tester.key,
    });

    //shorten polling for faster tests
    mgv._provider.pollingInterval = 10;
  });

  afterEach(async () => {
    mgv.disconnect();
  });

  it("reads allowance", async function () {
    const usdc = mgv.token("USDC");
    const allowance1 = await usdc.allowance();
    assert.deepStrictEqual(allowance1, Big(0), "allowance should start at 0");
    const resp = await usdc.approveMangrove({ amount: 100 });
    await resp.wait(1);
    const allowance2 = await usdc.allowance();
    assert.deepStrictEqual(allowance2, Big(100), "allowance should be 100");
  });

  it("converts", async function () {
    const usdc = mgv.token("USDC");
    assert.strictEqual(usdc.toFixed("10.3213"), "10.32");
    const weth = mgv.token("WETH");
    assert.strictEqual(weth.toFixed("10.32132"), "10.3213");
  });
});
