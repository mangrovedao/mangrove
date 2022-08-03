/**
 * Test that integration test infrastructure is working.
 */
import { describe, it } from "mocha";
import * as chai from "chai";
const { expect } = chai;
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
import Mangrove from "@mangrovedao/mangrove.js";

describe("Can connect to Mangrove on local chain", () => {
  it("should be able to connect to Mangrove", function () {
    return expect(
      Mangrove.connect({
        provider: this.server.url,
        privateKey: this.accounts.tester.key,
      })
    ).to.eventually.be.fulfilled;
  });
});
