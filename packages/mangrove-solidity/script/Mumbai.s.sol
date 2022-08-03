// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {ToyENS} from "./lib/ToyENS.sol";
import {MangroveDeployer} from "./lib/MangroveDeployer.sol";

contract MumbaiDeploy is MangroveDeployer {
  function run() public {
    deployMangrove({
      chief: msg.sender,
      gasprice: 50,
      gasmax: 1_000_000,
      useENS: false
    });
  }
}
