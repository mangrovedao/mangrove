// Write environment information to a file in the public folder
const { writeFileSync, mkdirSync } = require("fs");
const mangroveJsPackageJson = require("../../../node_modules/@mangrovedao/mangrove.js/package.json");

const main = async () => {
  const mangroveJsVersion = mangroveJsPackageJson.version;
  try {
    mkdirSync("static"); // Create if it does not exist
    // eslint-disable-next-line no-empty
  } catch (e) {}

  writeFileSync(
    "static/environmentInformation.json",
    JSON.stringify({ mangroveJsVersion })
  );
};

main();
