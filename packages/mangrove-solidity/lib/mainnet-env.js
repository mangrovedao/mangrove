const config = require("config");

module.exports = (ethers) => {
  let mainnetConfig;
  let networkName;

  if (config.has("ethereum")) {
    mainnetConfig = config.get("ethereum");
    networkName = "ethereum";
  }

  if (config.has("polygon")) {
    mainnetConfig = config.get("polygon");
    networkName = "polygon";
  }

  // if no network name is defined, then one is not forking mainnet
  if (!networkName) {
    return;
  }

  let env = {};

  env.mainnet = {
    network: mainnetConfig.network,
    name: networkName,
    tokens: getConfiguredTokens(mainnetConfig, networkName, ethers),
  };

  const childChainManager = getChildChainManager(mainnetConfig);
  if (childChainManager) {
    env.mainnet.childChainManager = childChainManager;
  }

  const mangrove = tryGetMangroveEnv(mainnetConfig, networkName, ethers);
  if (mangrove) {
    env.mainnet.mgv = mangrove;
  }

  const compound = tryGetCompoundEnv(mainnetConfig, networkName, ethers);
  if (compound) {
    env.mainnet.compound = compound;
  }

  const aave = tryGetAaveEnv(mainnetConfig, networkName, ethers);
  if (aave) {
    env.mainnet.aave = aave;
  }

  return env;
};

function getChildChainManager(mainnetConfig) {
  if (mainnetConfig.has("ChildChainManager")) {
    return mainnetConfig.get("ChildChainManager");
  }
}

function getConfiguredTokens(mainnetConfig, networkName, ethers) {
  let tokens = {};

  if (!mainnetConfig) {
    console.warn(
      `No network configuration was loaded, cannot fork ${networkName} mainnet`
    );
    return;
  }

  // DAI
  if (mainnetConfig.has("tokens.dai")) {
    const [daiContract, daiContractV2] = tryCreateTokenContract(
      "DAI",
      "dai",
      mainnetConfig,
      networkName,
      ethers
    );
    if (daiContract) {
      tokens.dai = { contract: daiContract };
    } else {
      console.warn("No DAI configuration found");
      return;
    }
    if (daiContractV2) {
      tokens.dai.V2 = daiContractV2;
    }
    const daiConfig = mainnetConfig.get("tokens.dai");
    if (daiConfig.has("adminAddress")) {
      tokens.dai.admin = daiConfig.get("adminAddress"); // to mint fresh DAIs on ethereum
    }
  }

  // USDC
  if (mainnetConfig.has("tokens.usdc")) {
    const [usdcContract, usdcContactV2] = tryCreateTokenContract(
      "USDC",
      "usdc",
      mainnetConfig,
      networkName,
      ethers
    );
    if (usdcContract) {
      tokens.usdc = { contract: usdcContract };
    } else {
      console.warn("No USDC configuration found");
      return;
    }
    if (usdcContactV2) {
      tokens.usdc.V2 = usdcContactV2;
    }
    const usdcConfig = mainnetConfig.get("tokens.usdc");
    if (usdcConfig.has("masterMinterAddress")) {
      tokens.usdc.masterMinter = usdcConfig.get("masterMinterAddress"); // to give mint allowance
    }
  }

  // WETH
  if (mainnetConfig.has("tokens.wEth")) {
    const [wEthContract, wEthContractV2] = tryCreateTokenContract(
      "WETH",
      "wEth",
      mainnetConfig,
      networkName,
      ethers
    );
    if (wEthContract) {
      tokens.wEth = { contract: wEthContract };
    } else {
      console.warn("No WETH configuration found");
      return;
    }
    if (wEthContractV2) {
      tokens.wEth.V2 = wEthContractV2;
    } // no minter for wEth, use deposit Eth
  }

  // Compound tokens
  // CDAI
  if (mainnetConfig.has("tokens.cDai")) {
    const [cDaiContract] = tryCreateTokenContract(
      "CDAI",
      "cDai",
      mainnetConfig,
      networkName,
      ethers
    );
    if (cDaiContract) {
      tokens.cDai = {
        contract: cDaiContract,
        isCompoundToken: true,
      };
    }
  }
  // CUSDC
  if (mainnetConfig.has("tokens.cUsdc")) {
    const [cUsdcContract] = tryCreateTokenContract(
      "CUSDC",
      "cUsdc",
      mainnetConfig,
      networkName,
      ethers
    );
    if (cUsdcContract) {
      tokens.cUsdc = {
        contract: cUsdcContract,
        isCompoundToken: true,
      };
    }
  }

  // CETH
  if (mainnetConfig.has("tokens.cwEth")) {
    const [cEthContract] = tryCreateTokenContract(
      "CWETH",
      "cwEth",
      mainnetConfig,
      networkName,
      ethers
    );
    if (cEthContract) {
      tokens.cwEth = {
        contract: cEthContract,
        isCompoundToken: true,
      };
    }
  }
  return tokens;
}

function tryCreateTokenContract(
  tokenName,
  configName,
  mainnetConfig,
  networkName,
  ethers
) {
  if (!mainnetConfig.has(`tokens.${configName}`)) {
    return [];
  }
  const tokenConfig = mainnetConfig.get(`tokens.${configName}`);

  if (!tokenConfig.has("address")) {
    console.warn(
      `Config for ${tokenName} does not specify an address on ${networkName}. Contract therefore not available.`
    );
    return [];
  }
  const [tokenAddress, tokenAddressOpt] = tokenConfig.has("address")
    ? [tokenConfig.get("address")]
    : [tokenConfig.get("V3"), tokenConfig.get("V2")];
  if (!tokenConfig.has("abi")) {
    console.warn(
      `Config for ${tokenName} does not specify an abi file for on ${networkName}. Contract therefore not available.`
    );
    return [];
  }
  const tokenAbi = require(tokenConfig.get("abi"));

  console.info(`$ token ${tokenName} ABI loaded. Address: ${tokenAddress}`);
  const contract = new ethers.Contract(tokenAddress, tokenAbi, ethers.provider);
  if (tokenAddressOpt) {
    return [
      contract,
      new ethers.Contract(tokenAddressOpt, tokenAbi, ethers.provider),
    ];
  } else {
    return [contract];
  }
}

function tryGetCompoundEnv(mainnetConfig, networkName, ethers) {
  if (!mainnetConfig.has("compound")) {
    return null;
  }
  let compoundConfig = mainnetConfig.get("compound");

  if (!compoundConfig.has("unitrollerAddress")) {
    console.warn(
      "Config for Compound does not specify a unitroller address. Compound is therefore not available."
    );
    return null;
  }
  const unitrollerAddress = compoundConfig.get("unitrollerAddress");
  if (!compoundConfig.has("unitrollerAbi")) {
    console.warn(
      `Config for Compound does not specify a unitroller abi file. Compound is therefore not available.`
    );
    return null;
  }
  const compAbi = require(compoundConfig.get("unitrollerAbi"));

  let compound = {
    contract: new ethers.Contract(unitrollerAddress, compAbi, ethers.provider),
  };

  if (compoundConfig.has("whale")) {
    const compoundWhale = compoundConfig.get("whale");
    compound.whale = compoundWhale;
  }

  console.info(
    `${networkName} Compound ABI loaded. Unitroller address: ${unitrollerAddress}`
  );
  return compound;
}

function tryGetAaveEnv(mainnetConfig, networkName, ethers) {
  if (!mainnetConfig.has("aave")) {
    return null;
  }
  const aaveConfig = mainnetConfig.get("aave");

  if (
    !(
      aaveConfig.has("addressesProvider.V2") &&
      aaveConfig.has("addressesProvider.V3") &&
      aaveConfig.has("addressesProvider.abi") &&
      aaveConfig.has("lendingPool.V2") &&
      aaveConfig.has("lendingPool.V3") &&
      aaveConfig.has("lendingPool.abi")
    )
  ) {
    console.warn(
      "Config for Aave does not specify an address provider. Aave is therefore not available."
    );
    return null;
  }

  const addressesProviderAbi = require(aaveConfig.get("addressesProvider.abi"));
  const lendingPoolAbi = require(aaveConfig.get("lendingPool.abi"));

  const addressesProvider = new ethers.Contract(
    aaveConfig.get("addressesProvider.V3"),
    addressesProviderAbi,
    ethers.provider
  );
  const addressesProviderV2 = new ethers.Contract(
    aaveConfig.get("addressesProvider.V2"),
    addressesProviderAbi,
    ethers.provider
  );

  const lendingPool = new ethers.Contract(
    aaveConfig.get("lendingPool.V3"),
    lendingPoolAbi,
    ethers.provider
  );
  const lendingPoolV2 = new ethers.Contract(
    aaveConfig.get("lendingPool.V2"),
    lendingPoolAbi,
    ethers.provider
  );

  const aave = {
    lendingPool: { contract: lendingPool, V2: lendingPoolV2 },
    addressesProvider: { contract: addressesProvider, V2: addressesProviderV2 },
    abis: {},
  };

  if (aaveConfig.has("extraAbis")) {
    aave.abis.stableDebtToken = require(aaveConfig.get(
      "extraAbis.stableDebtToken"
    ));
    aave.abis.variableDebtToken = require(aaveConfig.get(
      "extraAbis.variableDebtToken"
    ));
    aave.abis.aToken = require(aaveConfig.get("extraAbis.aToken"));
  }

  console.info(
    `${networkName} Aave ABI loaded. LendingPool is at: ${lendingPool.address}`
  );
  return aave;
}

function tryGetMangroveEnv(mainnetConfig, networkName, ethers) {
  if (!mainnetConfig.has("mangrove")) {
    console.warn(`Mangrove is not pre deployed on ${networkName} mainnet`);
    return null;
  }
  mangroveConfig = mainnetConfig.get("mangrove");
  mangrove = {};

  if (!mangroveConfig.has("address")) {
    console.warn(
      "Config for Mangrove does not specify an address. Contract therefore not available."
    );
    return null;
  }
  const mangroveAddress = mangroveConfig.get("address");
  if (mangroveConfig.has("abi")) {
    console.info(
      "Config for Mangrove specifies an abi file, so using that instead of artifacts in .build"
    );
    const mangroveAbi = require(mangroveConfig.get("abi"));
    mangrove.contract = new ethers.Contract(
      mangroveAddress,
      mangroveAbi,
      ethers.provider
    );
  } else {
    // NB (Espen): Hardhat launches tasks without awaiting, so async loading of env makes stuff difficult.
    //             It's not clear to me how to support loading the ABI from .build without async
    // const mangroveContractFactory = await ethers.getContractFactory("Mangrove");
    // mangrove.contract = mangroveContractFactory.attach(mangroveAddress);
    console.warn(
      "Config for Mangrove does not specify an abi file. Mangrove env is therefore not available."
    );
  }

  console.info(
    `${networkName} Mangrove ABI loaded. Address: ${mangroveAddress}`
  );
  return mangrove;
}
