import { CdpClient } from "@coinbase/cdp-sdk";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertPrivateFeeTestMode } from "./lib/private-fee-test-mode.mjs";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  stringToHex,
  zeroAddress,
} from "viem";

const CHAIN_ID = 4663;
const CONFIRMATIONS = 2;
const args = process.argv.slice(2);
const upgradeTest = args.includes("--upgrade-test");
const productionTest = args.includes("--production-test");
if (productionTest && upgradeTest) throw new Error("test modes cannot be combined");
const confirmationIndex = args.indexOf("--confirm");
const confirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";
if (!args.includes("--execute") || !/^0x[a-fA-F0-9]{64}$/.test(confirmation || "")) {
  throw new Error("test launch execution requires --execute --confirm 0xPLAN_TOKEN");
}

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function requiredAddress(name) {
  const value = required(name);
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is invalid`);
  return getAddress(value);
}

const planPath = resolve(process.cwd(), ".deployment-private", productionTest ? "automated-fee-production-test-plan.json" : upgradeTest ? "automated-fee-upgrade-test-plan.json" : "automated-fee-test-launch-plan.json");
const statePath = resolve(process.cwd(), ".deployment-private", productionTest ? "automated-fee-production-test-state.json" : upgradeTest ? "automated-fee-upgrade-test-state.json" : "automated-fee-test-launch-state.json");
const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.confirmationToken.toLowerCase() !== confirmation.toLowerCase()) throw new Error("test launch confirmation token does not match the persisted plan");
const expectedName = productionTest ? "test" : upgradeTest ? "Upgrade Test" : "Test";
const expectedSymbol = upgradeTest ? "UTEST" : "TEST";
const expectedWorkflow = productionTest ? "private_scheduled_engine_test" : upgradeTest ? "existing_token_upgrade_test" : "new_launch_vault_test";
if (plan.chainId !== CHAIN_ID || plan.launch?.name !== expectedName || plan.launch?.symbol !== expectedSymbol
  || plan.workflow !== expectedWorkflow
  || plan.launch?.pair !== "ETH" || plan.launch?.devBuy !== null || plan.indexedByPonsBot === true) {
  throw new Error("persisted test launch plan is invalid");
}
assertPrivateFeeTestMode(process.env, productionTest);

const launcher = getAddress(plan.launcher.address);
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const factory = getAddress(plan.execution.factory);
const vaultFactory = getAddress(plan.execution.vaultFactory);
const feeControl = getAddress(plan.execution.feeControl);
const feeEscrow = getAddress(plan.execution.feeEscrow);
const ponsbot = getAddress(plan.execution.ponsbot);
const token = getAddress(plan.prediction.token);
const curve = getAddress(plan.prediction.curve);
const predictedVault = getAddress(plan.automatedFees.predictedVault);
const vaultSalt = plan.automatedFees.vaultSalt;
const launchData = plan.execution.launchData;
const launchFee = BigInt(plan.execution.launchFeeWei);
if (!/^0x[a-fA-F0-9]+$/.test(launchData) || !/^0x[a-fA-F0-9]{64}$/.test(vaultSalt)) throw new Error("persisted test launch calldata is invalid");
if (keccak256(launchData) !== plan.launchDataHash
  || launcher.toLowerCase() !== requiredAddress("AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS").toLowerCase()
  || vaultFactory.toLowerCase() !== requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS").toLowerCase()
  || feeControl.toLowerCase() !== requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS").toLowerCase()) {
  throw new Error("private launch plan binding changed");
}

const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const cdp = new CdpClient({ apiKeyId: required("CDP_API_KEY_ID"), apiKeySecret: required("CDP_API_KEY_SECRET"), walletSecret: required("CDP_WALLET_SECRET") });
const [launcherAccount, adminAccount] = await Promise.all([
  cdp.evm.getOrCreateAccount({ name: "ponsbot-fee-test-launcher" }),
  cdp.evm.getOrCreateAccount({ name: process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin" }),
]);
if (launcherAccount.address.toLowerCase() !== launcher.toLowerCase()) throw new Error("test launcher CDP account mismatch");
if (adminAccount.address.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee admin CDP account mismatch");

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function transferCreatorFeeRecipient(address token,address newRecipient)",
]);
const vaultFactoryAbi = parseAbi([
  "function predictVaultAddress(bytes32 salt) view returns (address)",
  "function vaultOf(address token) view returns (address)",
  "function approvedFeeEscrow(address ponsFactoryAddress) view returns (address)",
  "function deployVault(bytes32 salt,(address token,address curve,address pairAsset,address ponsFactory,address feeEscrow,address ponsbot,address controller,address beneficiary,address feeControl) init) returns (address vault)",
]);
const controlAbi = parseAbi(["function processingEnabled() view returns (bool)"]);
const vaultAbi = parseAbi([
  "function token() view returns (address)", "function curve() view returns (address)", "function pairAsset() view returns (address)",
  "function ponsFactory() view returns (address)", "function feeEscrow() view returns (address)", "function ponsbot() view returns (address)",
  "function controller() view returns (address)", "function beneficiary() view returns (address)", "function feeControl() view returns (address)",
  "function active() view returns (bool)", "function paused() view returns (bool)",
]);

const [processingEnabled, livePrediction, approvedEscrow] = await Promise.all([
  client.readContract({ address: feeControl, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "predictVaultAddress", args: [vaultSalt] }),
  client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "approvedFeeEscrow", args: [factory] }),
]);
assertPrivateFeeTestMode(process.env, productionTest, processingEnabled);
if (livePrediction.toLowerCase() !== predictedVault.toLowerCase()) throw new Error("predicted vault changed");
if (approvedEscrow.toLowerCase() !== feeEscrow.toLowerCase()) throw new Error("approved Pons escrow changed");

let state;
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (state && state.confirmationToken.toLowerCase() !== confirmation.toLowerCase()) throw new Error("test launch state belongs to another plan");
state ||= { version: 1, confirmationToken: confirmation, launch: { status: "pending" }, vault: { status: "pending" }, assignment: { status: "pending" }, createdAt: new Date().toISOString() };

async function persist() {
  await mkdir(dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${statePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, statePath);
}

async function transactionExists(hash) {
  try { return Boolean(await client.getTransaction({ hash })); } catch { return false; }
}

async function sendSigned(signed, hash) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await transactionExists(hash)) return hash;
    try { return await client.sendRawTransaction({ serializedTransaction: signed }); } catch (error) {
      lastError = error;
      if (await transactionExists(hash)) return hash;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC rejected the signed test transaction");
}

async function signBroadcastConfirm({ account, to, data, value, nonce, idempotencyKey, stage }) {
  // Persist the exact request before signing and raw transaction before sending.
  // On retry, recover only that transaction, never allocate another nonce.
  const saved = state[stage];
  if (saved.signedTransaction) return confirmSaved(stage);
  let unsigned = saved.unsignedTransaction;
  if (!unsigned) {
  await client.call({ account: account.address, to, data, value });
  const [estimatedGas, feeEstimate, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to, data, value }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: account.address }),
  ]);
  const baseMaxFee = feeEstimate.maxFeePerGas ?? feeEstimate.gasPrice;
  if (!baseMaxFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseMaxFee * 2n;
  if (balance < value + gas * maxFeePerGas) throw new Error("transaction signer has insufficient ETH");
  const transaction = { chainId: CHAIN_ID, type: "eip1559", to, data, value, nonce, gas, maxFeePerGas, maxPriorityFeePerGas: feeEstimate.maxPriorityFeePerGas };
  unsigned = serializeTransaction(transaction);
  state[stage] = { ...saved, unsignedTransaction: unsigned, nonce, status: "prepared" };
  await persist();
  }
  const signingKey = `private-fee-test:${keccak256(stringToHex(`${idempotencyKey}:${keccak256(unsigned)}`))}`;
  const { signature } = await cdp.evm.signTransaction({ address: account.address, transaction: unsigned, idempotencyKey: signingKey });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== account.address.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
    || parsed.to?.toLowerCase() !== to.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== value) {
    throw new Error("signed test transaction envelope mismatch");
  }
  const localHash = keccak256(signature);
  state[stage] = { ...state[stage], signedTransaction: signature, transactionHash: localHash, status: "signed" };
  await persist();
  return confirmSaved(stage);
}

async function confirmSaved(stage) {
  const saved = state[stage];
  const localHash = keccak256(saved.signedTransaction);
  if (localHash !== saved.transactionHash) throw new Error("persisted transaction hash mismatch");
  const sentHash = await sendSigned(saved.signedTransaction, localHash);
  if (sentHash.toLowerCase() !== localHash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
  const receipt = await client.waitForTransactionReceipt({ hash: localHash, confirmations: CONFIRMATIONS, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${localHash} reverted`);
  return { hash: localHash, receipt };
}

async function verifyLaunch() {
  const launched = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  const expectedRecipient = upgradeTest && state.assignment?.status !== "confirmed" ? launcher : predictedVault;
  if (!launched.exists || launched.token.toLowerCase() !== token.toLowerCase() || launched.curve.toLowerCase() !== curve.toLowerCase()
    || launched.deployer.toLowerCase() !== launcher.toLowerCase() || launched.creatorFeeRecipient.toLowerCase() !== expectedRecipient.toLowerCase()
    || launched.pairToken !== zeroAddress || launched.creatorTaxBps !== 0 || launched.buybackEnabled) {
    throw new Error("confirmed Pons test launch state is incorrect");
  }
  return launched;
}

if (state.launch.status !== "confirmed") {
  const existing = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!state.launch.signedTransaction && (existing.exists || await client.getCode({ address: token }) || await client.getCode({ address: curve }))) {
    throw new Error("test launch addresses became occupied before broadcast");
  }
  const nonce = state.launch.nonce ?? await client.getTransactionCount({ address: launcher, blockTag: "pending" });
  if (nonce !== plan.launcher.nonce) throw new Error("test launcher nonce changed after preparation");
  const result = await signBroadcastConfirm({
    account: launcherAccount, to: factory, data: launchData, value: launchFee, nonce,
    idempotencyKey: `automated-fee-test-launch:${confirmation}`, stage: "launch",
  });
  await verifyLaunch();
  state.launch = { status: "confirmed", transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString(), confirmedAt: new Date().toISOString() };
  await persist();
  console.log(`Test launch confirmed: ${token}`);
} else {
  await verifyLaunch();
}

const init = { token, curve, pairAsset: zeroAddress, ponsFactory: factory, feeEscrow, ponsbot, controller: launcher, beneficiary: launcher, feeControl };
const vaultData = encodeFunctionData({ abi: vaultFactoryAbi, functionName: "deployVault", args: [vaultSalt, init] });
if (state.vault.status !== "confirmed") {
  const registered = await client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "vaultOf", args: [token] });
  if (!state.vault.signedTransaction && (registered !== zeroAddress || await client.getCode({ address: predictedVault }))) throw new Error("test vault address became occupied before deployment");
  const nonce = state.vault.nonce ?? await client.getTransactionCount({ address: admin, blockTag: "pending" });
  const result = await signBroadcastConfirm({
    account: adminAccount, to: vaultFactory, data: vaultData, value: 0n, nonce,
    idempotencyKey: `automated-fee-test-vault:${confirmation}`, stage: "vault",
  });
  const registeredAfter = await client.readContract({ address: vaultFactory, abi: vaultFactoryAbi, functionName: "vaultOf", args: [token] });
  if (registeredAfter.toLowerCase() !== predictedVault.toLowerCase()) throw new Error("vault factory registered an unexpected vault");
  state.vault = { status: "confirmed", transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString(), confirmedAt: new Date().toISOString() };
  await persist();
  console.log(`Test vault confirmed: ${predictedVault}`);
}

if (upgradeTest && state.assignment?.status !== "confirmed") {
  const launchedBeforeAssignment = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!state.assignment?.signedTransaction && launchedBeforeAssignment.creatorFeeRecipient.toLowerCase() !== launcher.toLowerCase()) {
    throw new Error("test launcher no longer controls the existing token's fee rights");
  }
  const assignmentData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "transferCreatorFeeRecipient",
    args: [token, predictedVault],
  });
  const nonce = state.assignment?.nonce ?? await client.getTransactionCount({ address: launcher, blockTag: "pending" });
  const result = await signBroadcastConfirm({
    account: launcherAccount,
    to: factory,
    data: assignmentData,
    value: 0n,
    nonce,
    idempotencyKey: `automated-fee-upgrade-test-assign:${confirmation}`,
    stage: "assignment",
  });
  state.assignment = { status: "confirmed", transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString(), confirmedAt: new Date().toISOString() };
  await persist();
  console.log(`Existing token fee rights assigned to vault: ${predictedVault}`);
}

if (upgradeTest) await verifyLaunch();

const [vaultToken, vaultCurve, pairAsset, vaultPonsFactory, vaultEscrow, vaultPonsbot, controller, beneficiary, vaultControl, active, paused, finalProcessing] = await Promise.all([
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "token" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "curve" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "pairAsset" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "ponsFactory" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "feeEscrow" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "ponsbot" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "controller" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "beneficiary" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "feeControl" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: predictedVault, abi: vaultAbi, functionName: "paused" }),
  client.readContract({ address: feeControl, abi: controlAbi, functionName: "processingEnabled" }),
]);
if (vaultToken.toLowerCase() !== token.toLowerCase() || vaultCurve.toLowerCase() !== curve.toLowerCase() || pairAsset !== zeroAddress
  || vaultPonsFactory.toLowerCase() !== factory.toLowerCase() || vaultEscrow.toLowerCase() !== feeEscrow.toLowerCase()
  || vaultPonsbot.toLowerCase() !== ponsbot.toLowerCase() || controller.toLowerCase() !== launcher.toLowerCase()
  || beneficiary.toLowerCase() !== launcher.toLowerCase() || vaultControl.toLowerCase() !== feeControl.toLowerCase()
  || !active || paused || finalProcessing !== productionTest) {
  throw new Error("post-deployment test vault verification failed");
}

console.log(JSON.stringify({
  status: productionTest ? "private_test_launch_and_vault_confirmed_processing_enabled" : "test_launch_and_vault_confirmed_processing_paused",
  mutationSent: true,
  indexedByPonsBot: false,
  processingEnabled: finalProcessing,
  token,
  curve,
  vault: predictedVault,
  launchTransactionHash: state.launch.transactionHash,
  vaultTransactionHash: state.vault.transactionHash,
  ...(upgradeTest ? { assignmentTransactionHash: state.assignment.transactionHash, workflow: "existing_token_upgrade_test" } : {}),
  statePath,
}, null, 2));
