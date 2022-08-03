// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {ENS} from "./lib/ToyENS.sol";
import {MangroveDeployer} from "./lib/MangroveDeployer.sol";

import {AbstractMangrove} from "mgv_src/AbstractMangrove.sol";
import {IERC20} from "mgv_src/MgvLib.sol";
import {TestToken} from "mgv_test/lib/tokens/TestToken.sol";
import {MangroveOrder} from "mgv_src/periphery/MangroveOrderEnriched.sol";
import {SimpleTestMaker} from "mgv_test/lib/agents/TestMaker.sol";
import {IMangrove} from "mgv_src/IMangrove.sol";

contract MangroveJsDeploy is MangroveDeployer {
  IERC20 tokenA;
  IERC20 tokenB;
  IERC20 dai;
  IERC20 usdc;
  IERC20 weth;
  SimpleTestMaker simpleTestMaker;
  MangroveOrder mgo;

  function run() public {
    deploy({chief: msg.sender, gasprice: 1, gasmax: 2_000_000, useENS: true});
  }

  function deploy(
    address chief,
    uint gasprice,
    uint gasmax,
    bool useENS
  ) internal {
    deployMangrove({
      chief: chief,
      gasprice: gasprice,
      gasmax: gasmax,
      useENS: useENS
    });

    vm.startBroadcast();

    tokenA = new TestToken({
      admin: chief,
      name: "Token A",
      symbol: "TokenA",
      _decimals: 18
    });

    tokenB = new TestToken({
      admin: chief,
      name: "Token B",
      symbol: "TokenB",
      _decimals: 18
    });

    dai = new TestToken({
      admin: chief,
      name: "DAI",
      symbol: "DAI",
      _decimals: 18
    });

    usdc = new TestToken({
      admin: chief,
      name: "USD Coin",
      symbol: "USDC",
      _decimals: 6
    });

    weth = new TestToken({
      admin: chief,
      name: "Wrapped Ether",
      symbol: "WETH",
      _decimals: 18
    });

    simpleTestMaker = new SimpleTestMaker({
      mgv: AbstractMangrove(payable(mgv)),
      base: tokenA,
      quote: tokenB
    });

    mgo = new MangroveOrder({_MGV: IMangrove(payable(mgv)), deployer: chief});

    if (useENS) {
      ENS.set("TokenA", address(tokenA), true);
      ENS.set("TokenB", address(tokenB), true);
      ENS.set("DAI", address(dai), true);
      ENS.set("USDC", address(usdc), true);
      ENS.set("WETH", address(weth), true);
      ENS.set("SimpleTestMaker", address(simpleTestMaker), false);
      ENS.set("MangroveOrder", address(mgo), false);
    }
    vm.stopBroadcast();
  }
}
