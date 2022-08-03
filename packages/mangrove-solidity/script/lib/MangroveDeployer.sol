// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {ENS} from "./ToyENS.sol";
import {Script, console} from "forge-std/Script.sol";

import "mgv_src/Mangrove.sol";
import "mgv_src/periphery/MgvReader.sol";
import {MangroveOrderEnriched} from "mgv_src/periphery/MangroveOrderEnriched.sol";
import {MgvCleaner} from "mgv_src/periphery/MgvCleaner.sol";
import {MgvOracle} from "mgv_src/periphery/MgvOracle.sol";
import {IMangrove} from "mgv_src/IMangrove.sol";

contract MangroveDeployer is Script {
  Mangrove mgv;
  MgvReader reader;
  MgvCleaner cleaner;
  MgvOracle oracle;
  MangroveOrderEnriched mgoe;

  function deployMangrove(
    address chief,
    uint gasprice,
    uint gasmax,
    bool useENS
  ) internal {
    vm.startBroadcast();

    mgv = new Mangrove({governance: chief, gasprice: gasprice, gasmax: gasmax});

    reader = new MgvReader({_mgv: payable(mgv)});

    cleaner = new MgvCleaner({_MGV: address(mgv)});

    oracle = new MgvOracle({_governance: chief, _initialMutator: chief});

    mgoe = new MangroveOrderEnriched({
      _MGV: IMangrove(payable(mgv)),
      deployer: chief
    });

    if (useENS) {
      ENS.set("Mangrove", payable(mgv), false);
      ENS.set("MgvReader", address(reader), false);
      ENS.set("MgvCleaner", address(cleaner), false);
      ENS.set("MgvOracle", address(oracle), false);
      ENS.set("MangroveOrderEnriched", address(mgoe), false);
    }
    vm.stopBroadcast();
  }
}
