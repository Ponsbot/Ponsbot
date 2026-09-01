import { CdpClient } from "@coinbase/cdp-sdk";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
} from "viem";

const CHAIN_ID = 4663;
const CONFIRMATIONS = 2;
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmationIndex = args.indexOf("--confirm");
const suppliedConfirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";

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

const privateDirectory = resolve(process.cwd(), ".deployment-private");
const planPath = resolve(privateDirectory, "automated-fee-test-launch-plan.json");
const statePath = resolve(privateDirectory, "automated-fee-test-launch-state.json");
const exitStatePath = resolve(privateDirectory, "automated-fee-test-vault-exit-state.json");
const [plan, launchState] = await Promise.all([
  readFile(planPath, "utf8").then(JSON.parse),
  readFile(statePath, "utf8").then(JSON.parse),
]);

if (plan.chainId !== CHAIN_ID || plan.launch?.name !== "Test" || plan.launch?.symbol !== "TEST") {
  throw new Error("persisted test launch plan is invalid");
}
if (launchState.launch?.status !== "confirmed" || launchState.vault?.status !== "confirmed") {
  throw new Error("test launch and vault must both be confirmed before exit");
}
if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") {
  throw new Error("automatic processing must remain disabled during the exit test");
}

const launcher = getAddress(plan.launcher.address);
const token = getAddress(plan.prediction.token);
const vault = getAddress(plan.automatedFees.predictedVault);
const factory = getAddress(plan.execution.factory);
const feeControl = getAddress(plan.execution.feeControl);
const confirmationToken = keccak256(stringToHex([
  "PONSBOT_TEST_VAULT_EXIT_V1", CHAIN_ID, token, vault, launcher, plan.confirmationToken,
].join(":")));

const client = createPublicClient({
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    timeout: 20_000,
    retryCount: 3,
  }),
});
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
]);
const controlAbi = parseAbi(["function processingEnabled() view returns (bool)"]);
const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function controller() view returns (address)",
  "function beneficiary() view returns (address)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function claimable(address beneficiaryAddress,address asset) view returns (uint256)",
  "function pause()",
  "function exit(address newPonsFeeRecipient)",
]);

async function readLiveState() {
  const [launched, vaultToken, controller, beneficiary, active, paused, processingEnabled, claimableNative] = await Promise.all([
    client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "token" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "controller" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "beneficiary" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "active" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }),
    client.readContract({ address: feeControl, abi: controlAbi, functionName: "processingEnabled" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "claimable", args: [launcher, "0x0000000000000000000000000000000000000000"] }),
  ]);
  return { launched, vaultToken, controller, beneficiary, active, paused, processingEnabled, claimableNative };
}

const initial = await readLiveState();
if (!initial.launched.exists || initial.vaultToken.toLowerCase() !== token.toLowerCase()
  || initial.controller.toLowerCase() !== launcher.toLowerCase()
  || initial.beneficiary.toLowerCase() !== launcher.toLowerCase() || initial.processingEnabled) {
  throw new Error("live test vault ownership or processing state is unexpected");
}

let alreadyExited = false;
if (!initial.active && initial.launched.creatorFeeRecipient.toLowerCase() === launcher.toLowerCase()) {
  console.log(JSON.stringify({
    status: "test_vault_already_exited",
    mutationSent: false,
    token,
    vault,
    feeRecipient: launcher,
    claimableNativeWei: initial.claimableNative.toString(),
  }, null, 2));
  alreadyExited = true;
} else if (!initial.active || initial.launched.creatorFeeRecipient.toLowerCase() !== vault.toLowerCase()) {
  throw new Error("TEST is not currently assigned to its active test vault");
}

if (!execute && !alreadyExited) {
  console.log(JSON.stringify({
    mode: "read_only_test_vault_exit_plan",
    mutationSent: false,
    confirmationToken,
    token,
    vault,
    currentFeeRecipient: initial.launched.creatorFeeRecipient,
    destinationFeeRecipient: launcher,
    vaultPaused: initial.paused,
    processingEnabled: false,
    claimableNativeWeiBeforeExit: initial.claimableNative.toString(),
    transactionsRequired: initial.paused ? 1 : 2,
    warning: "Exit permanently deactivates this test vault and returns future Pons fee rights to the test launcher wallet.",
  }, null, 2));
}
if (execute && !alreadyExited && suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) {
  throw new Error("test vault exit requires --execute --confirm 0xPLAN_TOKEN from the read-only plan");
}

if (execute && !alreadyExited) {
const cdp = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const launcherAccount = await cdp.evm.getOrCreateAccount({ name: "ponsbot-fee-test-launcher" });
if (launcherAccount.address.toLowerCase() !== launcher.toLowerCase()) throw new Error("test launcher CDP account mismatch");

let exitState;
try { exitState = JSON.parse(await readFile(exitStatePath, "utf8")); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
exitState ||= { version: 1, confirmationToken, pause: { status: "pending" }, exit: { status: "pending" } };
if (exitState.confirmationToken.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("exit state belongs to another plan");

async function persist() {
  exitState.updatedAt = new Date().toISOString();
  await writeFile(exitStatePath, `${JSON.stringify(exitState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  throw lastError instanceof Error ? lastError : new Error("RPC rejected the signed exit transaction");
}

async function signBroadcastConfirm({ data, idempotencyKey }) {
  await client.call({ account: launcher, to: vault, data });
  const [estimatedGas, feeEstimate, balance, nonce] = await Promise.all([
    client.estimateGas({ account: launcher, to: vault, data }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: launcher }),
    client.getTransactionCount({ address: launcher, blockTag: "pending" }),
  ]);
  const baseMaxFee = feeEstimate.maxFeePerGas ?? feeEstimate.gasPrice;
  if (!baseMaxFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseMaxFee * 2n;
  if (balance < gas * maxFeePerGas) throw new Error("test launcher has insufficient ETH for vault exit gas");
  const transaction = {
    chainId: CHAIN_ID, type: "eip1559", to: vault, data, value: 0n, nonce, gas, maxFeePerGas,
    maxPriorityFeePerGas: feeEstimate.maxPriorityFeePerGas,
  };
  const { signature } = await cdp.evm.signTransaction({
    address: launcher,
    transaction: serializeTransaction(transaction),
    idempotencyKey,
  });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== launcher.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
    || parsed.to?.toLowerCase() !== vault.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== 0n) {
    throw new Error("signed test exit transaction envelope mismatch");
  }
  const localHash = keccak256(signature);
  const sentHash = await sendSigned(signature, localHash);
  if (sentHash.toLowerCase() !== localHash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
  const receipt = await client.waitForTransactionReceipt({ hash: localHash, confirmations: CONFIRMATIONS, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${localHash} reverted`);
  return { hash: localHash, blockNumber: receipt.blockNumber.toString() };
}

if (!initial.paused && exitState.pause.status !== "confirmed") {
  const result = await signBroadcastConfirm({
    data: encodeFunctionData({ abi: vaultAbi, functionName: "pause" }),
    idempotencyKey: `automated-fee-test-exit-pause:${confirmationToken}`,
  });
  exitState.pause = { status: "confirmed", transactionHash: result.hash, blockNumber: result.blockNumber };
  await persist();
}

const beforeExit = await readLiveState();
if (!beforeExit.paused) throw new Error("test vault did not enter paused state");
if (exitState.exit.status !== "confirmed") {
  const result = await signBroadcastConfirm({
    data: encodeFunctionData({ abi: vaultAbi, functionName: "exit", args: [launcher] }),
    idempotencyKey: `automated-fee-test-exit-final:${confirmationToken}`,
  });
  exitState.exit = { status: "confirmed", transactionHash: result.hash, blockNumber: result.blockNumber };
  await persist();
}

const final = await readLiveState();
if (final.active || final.launched.creatorFeeRecipient.toLowerCase() !== launcher.toLowerCase()
  || !final.paused || final.processingEnabled) {
  throw new Error("post-exit verification failed");
}

console.log(JSON.stringify({
  status: "test_vault_exited_fee_rights_returned",
  mutationSent: true,
  token,
  vault,
  feeRecipient: launcher,
  processingEnabled: false,
  vaultActive: false,
  vaultPaused: true,
  pauseTransactionHash: exitState.pause.transactionHash,
  exitTransactionHash: exitState.exit.transactionHash,
  claimableNativeWeiAfterExit: final.claimableNative.toString(),
  exitStatePath,
}, null, 2));
}
