/*
Script to a write addresses for a chain to a json file (at a given path), given a deployment-folder
with hardhat deployment json files with addresses for Mangrove contracts.

Writes a new file, if output file is not already present. If output file is found, only updates the
values for the chain and contracts corresponding to the given argument for chainkey and the known
names of Mangrove contracts, and leaves other key-value pairs.

Args:
  --deployment=<path to deployments folder for addresses>
  --chainkey=<key for chain in output json file>
  --output=<path to output json file>
  [--debug]

  Add --debug flag to get debug output.

Example:

  ts-node write-addresses-json --deployment ../../../packages/mangrove-solidity/deployments/mumbai --chainkey maticmum --output ../../../packages/mangrove.js/src/constants/addresses.json 
*/

import fs from 'fs';
import minimist from 'minimist';
import * as addressHandling from "./address-handling";

// define relevant contracts
const coreContracts = [ "Mangrove", "MgvCleaner", "MgvReader", "MgvOracle", "MangroveOrderEnriched" ];

// read args - and do minimal sanity checking
const stringArgs = ['deployment', 'chainkey', 'output'];

const args = minimist(
  process.argv.slice(2), {
    string: stringArgs, 
    boolean: ["debug"], 
    unknown: (a) => {console.error(`Unexpected argument '${a}'- ignoring.`); return false; }
  });

let debug = false;
if(args.debug){
  debug = true;
}

if(debug){
  console.debug("Args:")
  console.debug(args);
}

let error = false;
for (let i = 0; i < stringArgs.length; i++) {
  const name = stringArgs[i];

  if(!(name in args)){
    console.error(`Error: Missing argument ${name}.`);
    error = true;
  }
}

if(error){
  process.exit(1);
}

const deploymentFolder: string = args['deployment'];
const chainkey: string = args['chainkey'];
const outputFile: string = args['output'];

// read deployment addresses for core contracts
const contractAddresses = addressHandling.readContractAddresses(deploymentFolder, coreContracts);

// read outputFile, if present
let oldAddresses: Record<string, {}> = {};
if (fs.existsSync(outputFile)) {
  if(debug){
    console.debug(`Found existing file at ${outputFile}. File will be updated.`);
  }

  oldAddresses = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
}
else {
  if(debug){
    console.debug(`Did not find file at ${outputFile}. File will be created.`);
  }
}

// Overwrite info for relevant addresses for the relevant chainkey, and then write to file.
// (Note - we don't test whether there are actually any changes, and we always write to file, so
// the file timestamp will always be updated. This script is intended for CI, so it's an
// unnecessary hassle to actually test for changes.) 

const newChainAddresses = Object.assign(oldAddresses[chainkey] ?? {}, contractAddresses);
const newAddresses = Object.assign(oldAddresses, {[chainkey] : newChainAddresses});

if(debug){
  console.debug(`Constructed the following content, which will be written to file at ${outputFile}:`)
  console.dir(newAddresses);
}

fs.writeFileSync(outputFile, JSON.stringify(newAddresses, null, 2));
