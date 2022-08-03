// TODO do not distribute in browser version
import { ethers } from "ethers";
import { testServer, Mangrove } from "..";

const params = {
  host: "127.0.0.1",
  port: 8546,
  pipeAnvil: false,
  script: "MangroveJsDeploy",
};

export const mochaHooks = {
  async beforeAll() {
    this.server = await testServer(params).defaultRun();
    this.accounts = {
      deployer: this.server.accounts[0],
      maker: this.server.accounts[1],
      cleaner: this.server.accounts[2],
      tester: this.server.accounts[3],
    };

    const provider = new ethers.providers.JsonRpcProvider(this.server.url);

    const mgv = await Mangrove.connect({
      provider,
      privateKey: this.accounts.deployer.key,
    });

    const tokenA = mgv.token("TokenA");
    const tokenB = mgv.token("TokenB");
    //shorten polling for faster tests
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    mgv._provider.pollingInterval = 10;
    await mgv.fundMangrove(10, this.accounts.deployer.address);
    // await mgv.contract["fund()"]({ value: mgv.toUnits(10,18) });

    await mgv.contract
      .activate(tokenA.address, tokenB.address, 0, 10, 20000)
      .then((tx) => tx.wait());
    await mgv.contract
      .activate(tokenB.address, tokenA.address, 0, 10, 20000)
      .then((tx) => tx.wait());

    await tokenA.contract.mint(
      this.accounts.tester.address,
      mgv.toUnits(10, 18)
    );
    await tokenB.contract.mint(
      this.accounts.tester.address,
      mgv.toUnits(10, 18)
    );

    const tx = await mgv.fundMangrove(10, mgv.getAddress("SimpleTestMaker"));
    // making sure that last one is mined before snapshotting, anvil may snapshot too early otherwise
    await tx.wait();

    await this.server.snapshot();
  },

  async beforeEach() {
    await this.server.revert();
    await this.server.snapshot();
  },

  async afterAll() {
    if (this.server.process) {
      this.server.process.kill();
    }
  },
};
