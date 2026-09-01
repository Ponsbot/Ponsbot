import { CdpClient } from "@coinbase/cdp-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertPrivateFeeTestMode } from "./lib/private-fee-test-mode.mjs";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
} from "viem";

const CHAIN_ID = 4663;
const upgradeTest = process.argv.slice(2).includes("--upgrade-test");
const productionTest = process.argv.slice(2).includes("--production-test");
if (productionTest && upgradeTest) throw new Error("test modes cannot be combined");
const NAME = productionTest ? "test" : upgradeTest ? "Upgrade Test" : "Test";
const SYMBOL = upgradeTest ? "UTEST" : "TEST";
const LAUNCHER_ACCOUNT_NAME = "ponsbot-fee-test-launcher";
const PONSBOT = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function requiredAddress(name, fallback = "") {
  const value = String(process.env[name] ?? fallback).trim();
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is missing or invalid`);
  return getAddress(value);
}

const EXPECTED_LAUNCHER = requiredAddress("AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS");

function stable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ batch: { multicall: true }, transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const factory = requiredAddress("PONS_V2_FACTORY_ADDRESS", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const vaultFactory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
const feeControl = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const launcher = EXPECTED_LAUNCHER;
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const launchConfigId = BigInt(process.env.PONS_LAUNCH_CONFIG_ID?.trim() || "0");
if (launchConfigId < 0n) throw new Error("PONS_LAUNCH_CONFIG_ID is invalid");
assertPrivateFeeTestMode(process.env, productionTest);

const cdp = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const launcherAccount = await cdp.evm.getOrCreateAccount({ name: LAUNCHER_ACCOUNT_NAME });
if (launcherAccount.address.toLowerCase() !== launcher.toLowerCase()) throw new Error("dedicated CDP test launcher address changed");

const factoryAbi = parseAbi([
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function feeEscrow() view returns (address)",
  "function buybackVault() view returns (address)",
  "function launchDeployer() view returns (address)",
  "function memeHook() view returns (address)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)",
]);
const hookAbi = parseAbi(["function currentFeePolicy() view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))"]);
const deployerAbi = parseAbi(["function predictLaunchAddresses((address pairToken,address creatorFeeRecipient,address originalDeployer,address feePolicy,(address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps) policy,address feeEscrow,address buybackVault,uint256 phantomQuote,uint256 curveFeeBps,uint256 creatorTaxBps,bool buybackEnabled,uint256 graduationThreshold,uint256 supply,bytes32 salt,string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials)) view returns (address token,address curve)"]);
const vaultFactoryAbi = parseAbi([
  "function predictVaultAddress(bytes32 salt) view returns (address)",
  "function vaultOf(address token) view returns (address)",
  "function approvedFeeEscrow(address ponsFactoryAddress) view returns (address)",
]);
const controlAbi = parseAbi(["function processingEnabled() view returns (bool)", "function admin() view returns (address)"]);

const testVersion = productionTest ? "production-private-v1" : "v1";
const vaultSalt = keccak256(stringToHex(`ponsbot-private-automated-fee-test-vault:${NAME}:${SYMBOL}:${testVersion}`));
const [
  predictedVault, config, expectedEconomics, launchFee, feeEscrow, ponsBuybackVault,
  launchDeployer, memeHook, processingEnabled, controlAdmin, approvedEscrow,
  launcherBalance, launcherNonce, adminBalance,
] = await Promise.all([
  client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "predictVaultAddress", args: [vaultSalt] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchConfig", args: [launchConfigId] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [launchConfigId, zeroAddress] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "buybackVault" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchDeployer" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
  client.readContract({ address: feeControl, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: feeControl, abi: controlAbi, functionName: "admin" }),
  client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "approvedFeeEscrow", args: [factory] }),
  client.getBalance({ address: launcher }),
  client.getTransactionCount({ address: launcher, blockTag: "pending" }),
  client.getBalance({ address: admin }),
]);
if (!config.enabled) throw new Error(`Pons launch configuration ${launchConfigId} is disabled`);
assertPrivateFeeTestMode(process.env, productionTest, processingEnabled);
if (controlAdmin.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee control admin mismatch");
if (approvedEscrow.toLowerCase() !== feeEscrow.toLowerCase()) throw new Error("current Pons factory and escrow are not approved by the vault factory");
if (await client.getCode({ address: predictedVault })) throw new Error("predicted test vault address already contains bytecode");

const policy = await client.readContract({ address: memeHook, abi: hookAbi, functionName: "currentFeePolicy" });
const socials = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
const predictionBase = {
  pairToken: zeroAddress,
  creatorFeeRecipient: upgradeTest ? launcher : predictedVault,
  originalDeployer: launcher,
  feePolicy: memeHook,
  policy,
  feeEscrow,
  buybackVault: ponsBuybackVault,
  phantomQuote: config.phantomQuote,
  curveFeeBps: config.curveFeeBps,
  creatorTaxBps: 0n,
  buybackEnabled: false,
  graduationThreshold: config.graduationThreshold,
  supply: config.supply,
  name: NAME,
  symbol: SYMBOL,
  logo: "",
  description: "",
  socials,
};
const saltSeed = keccak256(stringToHex(`ponsbot-private-automated-fee-test-launch:${launcher}:${upgradeTest ? launcher : predictedVault}:${NAME}:${SYMBOL}:${testVersion}`));
let selected;
const batchSize = 24;
for (let offset = 0; offset < 100_000 && !selected; offset += batchSize) {
  const candidates = Array.from({ length: Math.min(batchSize, 100_000 - offset) }, (_, index) => {
    const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [saltSeed, BigInt(offset + index)]));
    return { salt, contract: { address: launchDeployer, abi: deployerAbi, functionName: "predictLaunchAddresses", args: [{ ...predictionBase, salt }] } };
  });
  const results = await client.multicall({ contracts: candidates.map((candidate) => candidate.contract), allowFailure: true, multicallAddress: MULTICALL });
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === "success" && results[index].result[0].toLowerCase().endsWith("b07")) {
      selected = { salt: candidates[index].salt, token: results[index].result[0], curve: results[index].result[1], attempt: offset + index + 1 };
      break;
    }
  }
}
if (!selected) throw new Error("could not find a b07 test-token address in 100,000 candidates");

const [persistedPrediction, tokenCode, curveCode, priorLaunch, priorVault] = await Promise.all([
  client.readContract({ address: launchDeployer, abi: deployerAbi, functionName: "predictLaunchAddresses", args: [{ ...predictionBase, salt: selected.salt }] }),
  client.getCode({ address: selected.token }),
  client.getCode({ address: selected.curve }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [selected.token] }),
  client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "vaultOf", args: [selected.token] }),
]);
if (persistedPrediction[0].toLowerCase() !== selected.token.toLowerCase() || persistedPrediction[1].toLowerCase() !== selected.curve.toLowerCase()) {
  throw new Error("persisted Pons prediction changed");
}
if (tokenCode || curveCode || priorLaunch.exists || priorVault !== zeroAddress) throw new Error("predicted test addresses are already in use");

const params = {
  name: NAME,
  symbol: SYMBOL,
  logo: "",
  description: "",
  socials,
  creatorFeeRecipient: upgradeTest ? launcher : predictedVault,
  creatorTaxBps: 0,
  buybackEnabled: false,
  expectedEconomics,
  salt: selected.salt,
};
const launchData = encodeFunctionData({
  abi: factoryAbi,
  functionName: "launchToken",
  args: [params, launchConfigId, zeroAddress, []],
});
const simulation = await client.simulateContract({
  account: launcher,
  address: factory,
  abi: factoryAbi,
  functionName: "launchToken",
  args: [params, launchConfigId, zeroAddress, []],
  value: launchFee,
});
if (simulation.result[0].toLowerCase() !== selected.token.toLowerCase() || simulation.result[1].toLowerCase() !== selected.curve.toLowerCase()) {
  throw new Error("launch simulation disagrees with predicted token or curve");
}
const [estimatedGas, fees] = await Promise.all([
  client.estimateGas({ account: launcher, to: factory, data: launchData, value: launchFee }),
  client.estimateFeesPerGas(),
]);
const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
if (!maxFeePerGas) throw new Error("RPC did not provide a launch fee estimate");
const conservativeLaunchCost = launchFee + estimatedGas * 120n / 100n * maxFeePerGas * 2n;
if (launcherBalance < conservativeLaunchCost) throw new Error("dedicated test launcher is underfunded for the simulated launch");

const plan = {
  version: 1,
  chainId: CHAIN_ID,
  workflow: productionTest ? "private_scheduled_engine_test" : upgradeTest ? "existing_token_upgrade_test" : "new_launch_vault_test",
  launch: {
    name: NAME,
    symbol: SYMBOL,
    pair: "ETH",
    devBuy: null,
    image: "",
    description: "",
    socials,
    launchConfigId: launchConfigId.toString(),
    launchFeeWei: launchFee.toString(),
    launchFeeEth: formatEther(launchFee),
    estimatedGas: estimatedGas.toString(),
    conservativeLaunchCostWei: conservativeLaunchCost.toString(),
  },
  launcher: { accountName: LAUNCHER_ACCOUNT_NAME, address: launcher, nonce: launcherNonce, balanceWei: launcherBalance.toString(), balanceEth: formatEther(launcherBalance) },
  admin: { address: admin, balanceWei: adminBalance.toString(), balanceEth: formatEther(adminBalance) },
  automatedFees: { processingEnabled, vaultFactory, feeControl, vaultSalt, predictedVault },
  prediction: { salt: selected.salt, token: selected.token, curve: selected.curve, attempt: selected.attempt },
  launchDataHash: keccak256(launchData),
};
const confirmationToken = keccak256(stringToHex(JSON.stringify(stable(plan))));
const planPath = resolve(
  process.cwd(),
  ".deployment-private",
  productionTest ? "automated-fee-production-test-plan.json" : upgradeTest ? "automated-fee-upgrade-test-plan.json" : "automated-fee-test-launch-plan.json",
);
await mkdir(dirname(planPath), { recursive: true });
await writeFile(planPath, `${JSON.stringify({
  confirmationToken,
  ...stable(plan),
  execution: {
    factory,
    feeEscrow,
    feeControl,
    vaultFactory,
    ponsbot: PONSBOT,
    launchData,
    launchFeeWei: launchFee.toString(),
  },
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({
  mode: upgradeTest ? "read_only_existing_token_upgrade_test_preparation" : "read_only_test_launch_preparation",
  mutationSent: false,
  simulated: true,
  indexedByPonsBot: false,
  confirmationToken,
  planPath,
  ...plan,
}, null, 2));
console.log("No transaction was signed or broadcast. The test token and vault do not exist yet.");
