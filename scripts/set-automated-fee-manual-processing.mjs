import { CdpClient } from "@coinbase/cdp-sdk";
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
const args = process.argv.slice(2);
const enabling = args.includes("--enable");
const disabling = args.includes("--disable");
const execute = args.includes("--execute");
if (enabling === disabling) throw new Error("choose exactly one of --enable or --disable");
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

const configuredTokens = [...new Set((process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean))];
if (configuredTokens.length !== 1) throw new Error("exactly one manual test token must be configured");
const UTEST = getAddress(configuredTokens[0]);
const UTEST_VAULT = requiredAddress("AUTOMATED_FEE_MANUAL_TEST_VAULT_ADDRESS");

if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") {
  throw new Error("production automated buyback and burn must remain disabled during manual testing");
}
if (process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("AUTOMATED_FEE_MANUAL_TEST_ENABLED must be true");
}
const allowlist = configuredTokens.map((value) => value.toLowerCase());
if (allowlist.length !== 1 || allowlist[0] !== UTEST.toLowerCase()) {
  throw new Error("manual processing must be restricted exclusively to UTEST");
}

const control = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const expectedAdapter = requiredAddress("AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS");
const expectedKeeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
const expectedAuthorizer = requiredAddress("AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS");
const client = createPublicClient({
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }),
});
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const controlAbi = parseAbi([
  "function processingEnabled() view returns (bool)",
  "function admin() view returns (address)",
  "function keeper() view returns (address)",
  "function quoteAuthorizer() view returns (address)",
  "function executionAdapter() view returns (address)",
  "function enableProcessing()",
  "function pauseProcessing()",
]);
const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
]);
const [currentlyEnabled, liveAdmin, liveKeeper, liveAuthorizer, liveAdapter, vaultToken, vaultActive, vaultPaused] = await Promise.all([
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "admin" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "keeper" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "quoteAuthorizer" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "executionAdapter" }),
  client.readContract({ address: UTEST_VAULT, abi: vaultAbi, functionName: "token" }),
  client.readContract({ address: UTEST_VAULT, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: UTEST_VAULT, abi: vaultAbi, functionName: "paused" }),
]);
if (liveAdmin.toLowerCase() !== admin.toLowerCase() || liveKeeper.toLowerCase() !== expectedKeeper.toLowerCase()
  || liveAuthorizer.toLowerCase() !== expectedAuthorizer.toLowerCase() || liveAdapter.toLowerCase() !== expectedAdapter.toLowerCase()) {
  throw new Error("live automated-fee control bindings do not match configuration");
}
if (vaultToken.toLowerCase() !== UTEST.toLowerCase() || !vaultActive || vaultPaused) {
  throw new Error("UTEST vault is not active and ready for isolated processing");
}

const desiredEnabled = enabling;
const action = enabling ? "enableProcessing" : "pauseProcessing";
const confirmationToken = keccak256(stringToHex([
  "PONSBOT_MANUAL_PROCESSING_STATE_V1", CHAIN_ID, control, UTEST, UTEST_VAULT, action,
].join(":")));
if (currentlyEnabled === desiredEnabled) {
  console.log(JSON.stringify({
    status: desiredEnabled ? "manual_processing_already_enabled" : "manual_processing_already_paused",
    mutationSent: false,
    productionAutomaticEnabled: false,
    allowlistedToken: UTEST,
    processingEnabled: currentlyEnabled,
  }, null, 2));
} else if (!execute) {
  console.log(JSON.stringify({
    mode: "read_only_manual_processing_state_change",
    mutationSent: false,
    action,
    confirmationToken,
    productionAutomaticEnabled: false,
    allowlistedToken: UTEST,
    vault: UTEST_VAULT,
    processingEnabledBefore: currentlyEnabled,
    processingEnabledAfter: desiredEnabled,
  }, null, 2));
} else {
  if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) {
    throw new Error("manual processing state change requires the exact confirmation token from dry-run mode");
  }
  const cdp = new CdpClient({
    apiKeyId: required("CDP_API_KEY_ID"),
    apiKeySecret: required("CDP_API_KEY_SECRET"),
    walletSecret: required("CDP_WALLET_SECRET"),
  });
  const accountName = process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin";
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  if (account.address.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee admin CDP account mismatch");
  const data = encodeFunctionData({ abi: controlAbi, functionName: action });
  await client.call({ account: admin, to: control, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: admin, to: control, data }),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: admin, blockTag: "pending" }),
    client.getBalance({ address: admin }),
  ]);
  const baseFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (!baseFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseFee * 2n;
  if (balance < gas * maxFeePerGas) throw new Error("automated fee admin has insufficient ETH");
  const transaction = {
    chainId: CHAIN_ID, type: "eip1559", to: control, data, value: 0n, nonce, gas, maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const { signature } = await cdp.evm.signTransaction({
    address: admin,
    transaction: serializeTransaction(transaction),
    idempotencyKey: `automated-fee-manual-${action}:${confirmationToken}`,
  });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== admin.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
    || parsed.to?.toLowerCase() !== control.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== 0n) {
    throw new Error("signed processing-state transaction envelope mismatch");
  }
  const transactionHash = keccak256(signature);
  const submittedHash = await client.sendRawTransaction({ serializedTransaction: signature });
  if (submittedHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("processing-state transaction reverted");
  const processingEnabled = await client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" });
  if (processingEnabled !== desiredEnabled) throw new Error("processing-state postcondition failed");
  console.log(JSON.stringify({
    status: desiredEnabled ? "manual_processing_enabled" : "manual_processing_paused",
    mutationSent: true,
    productionAutomaticEnabled: false,
    allowlistedToken: UTEST,
    processingEnabled,
    transactionHash,
  }, null, 2));
}
