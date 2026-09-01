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
if (confirmationIndex >= 0 && (!suppliedConfirmation || suppliedConfirmation.startsWith("--"))) {
  throw new Error("--confirm requires the exact token printed by dry-run mode");
}
if (!execute && confirmationIndex >= 0) throw new Error("--confirm is only valid with --execute");

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

function enabled(name) {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function confirmationToken(value) {
  return keccak256(stringToHex(JSON.stringify(stable(value))));
}

const requestedCapabilities = {
  master: enabled("AUTOMATED_BUYBACK_BURN_ENABLED"),
  processing: enabled("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED"),
  newLaunchEnrollment: enabled("AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED"),
  existingLaunchUpgrade: enabled("AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED"),
  botCommands: enabled("AUTOMATED_FEE_BOT_COMMANDS_ENABLED"),
  manualTest: enabled("AUTOMATED_FEE_MANUAL_TEST_ENABLED"),
};
if (enabling) {
  if (!requestedCapabilities.master || !requestedCapabilities.processing) {
    throw new Error("production master and sweep/buyback/burn flags must both be true before activation");
  }
  if (requestedCapabilities.newLaunchEnrollment || requestedCapabilities.existingLaunchUpgrade) {
    throw new Error("new-launch enrollment and existing-token upgrades must remain false for this staged activation");
  }
  if (requestedCapabilities.manualTest) {
    throw new Error("AUTOMATED_FEE_MANUAL_TEST_ENABLED must be false before production processing is enabled");
  }
}

const site = String(process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
const signer = String(process.env.WALLET_SIGNER_URL ?? (site ? `${site}/api/wallet-signer` : "")).trim().replace(/\/$/, "");
const signerToken = required("WALLET_SIGNER_TOKEN");
if (!/^https:\/\//i.test(signer) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(signer)) {
  throw new Error("WALLET_SIGNER_URL or NEXT_PUBLIC_SITE_URL is missing or invalid");
}

const control = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const client = createPublicClient({
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }),
});
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");
const controlAbi = parseAbi([
  "function processingEnabled() view returns (bool)",
  "function admin() view returns (address)",
  "function enableProcessing()",
  "function pauseProcessing()",
]);
const [currentlyEnabled, liveAdmin, controlCode] = await Promise.all([
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "admin" }),
  client.getCode({ address: control }),
]);
if (liveAdmin.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee control admin does not match configuration");
if (!controlCode || controlCode === "0x") throw new Error("automated fee control is not deployed");

let infrastructure = null;
if (enabling) {
  const response = await fetch(`${signer}/v1/automated-fees/infrastructure-status`, {
    method: "POST",
    headers: { authorization: `Bearer ${signerToken}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`production readiness endpoint failed (${response.status}): ${raw.slice(0, 500)}`);
  infrastructure = JSON.parse(raw);
  const missingRoutes = (infrastructure.routes ?? []).filter((route) => !route.matches).map((route) => route.symbol);
  const missingContracts = Object.entries(infrastructure.contractCode ?? {}).filter(([, present]) => !present).map(([name]) => name);
  const lowBalanceRoles = Object.entries(infrastructure.balancesWei ?? {})
    .filter(([role]) => role !== "quoteAuthorizer")
    .filter(([, balance]) => BigInt(String(balance)) < 5_000_000_000_000_000n)
    .map(([role]) => role);
  if (infrastructure.chainId !== CHAIN_ID || infrastructure.configurationValid !== true
    || infrastructure.processingEnabled !== false || infrastructure.allRoutesReady !== true
    || infrastructure.allContractsDeployed !== true || infrastructure.controlMatches !== true
    || infrastructure.factoryMatches !== true || infrastructure.enrollmentProofConfigured !== true
    || missingRoutes.length > 0 || missingContracts.length > 0 || lowBalanceRoles.length > 0) {
    throw new Error(`production infrastructure is not ready: ${JSON.stringify({ missingRoutes, missingContracts, lowBalanceRoles })}`);
  }
}

const desiredEnabled = enabling;
const action = enabling ? "enableProcessing" : "pauseProcessing";
const identity = {
  version: 1,
  chainId: CHAIN_ID,
  action,
  control,
  admin,
  capabilities: requestedCapabilities,
  routes: enabling ? infrastructure.routes.map((route) => ({
    symbol: route.symbol,
    pairAsset: route.pairAsset,
    matches: route.matches,
  })) : [],
};
const token = confirmationToken(identity);
if (currentlyEnabled === desiredEnabled) {
  console.log(JSON.stringify({
    status: desiredEnabled ? "production_processing_already_enabled" : "production_processing_already_paused",
    mutationSent: false,
    processingEnabled: currentlyEnabled,
    requestedCapabilities,
  }, null, 2));
  process.exit(0);
}
if (!execute) {
  console.log(JSON.stringify({
    mode: "read_only_production_processing_state_change",
    mutationSent: false,
    action,
    confirmationToken: token,
    processingEnabledBefore: currentlyEnabled,
    processingEnabledAfter: desiredEnabled,
    configuredRoutes: enabling ? infrastructure.routes.filter((route) => route.matches).length : undefined,
    totalRoutes: enabling ? infrastructure.routes.length : undefined,
    requestedCapabilities,
  }, null, 2));
  console.log(`No transaction was signed or broadcast. To perform this exact state change, pass --execute --confirm ${token}`);
  process.exit(0);
}
if (suppliedConfirmation.toLowerCase() !== token.toLowerCase()) {
  throw new Error("production processing confirmation token does not match the current dry-run plan");
}

const cdp = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const accountName = process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin";
if (!/^[A-Za-z0-9_-]{3,80}$/.test(accountName)) throw new Error("AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME is invalid");
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
  chainId: CHAIN_ID,
  type: "eip1559",
  to: control,
  data,
  value: 0n,
  nonce,
  gas,
  maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
};
const { signature } = await cdp.evm.signTransaction({
  address: admin,
  transaction: serializeTransaction(transaction),
  idempotencyKey: `automated-fee-production-${action}:v1:${token}`,
});
const sender = await recoverTransactionAddress({ serializedTransaction: signature });
const parsed = parseTransaction(signature);
if (sender.toLowerCase() !== admin.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
  || parsed.to?.toLowerCase() !== control.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== 0n) {
  throw new Error("signed production processing transaction envelope mismatch");
}
const transactionHash = keccak256(signature);
let submittedHash;
try {
  submittedHash = await client.sendRawTransaction({ serializedTransaction: signature });
} catch (error) {
  try {
    const existing = await client.getTransaction({ hash: transactionHash });
    submittedHash = existing.hash;
  } catch {
    throw error;
  }
}
if (submittedHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
if (receipt.status !== "success") throw new Error("production processing state transaction reverted");
const processingEnabled = await client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" });
if (processingEnabled !== desiredEnabled) throw new Error("production processing postcondition failed");
console.log(JSON.stringify({
  status: desiredEnabled ? "production_processing_enabled" : "production_processing_paused",
  mutationSent: true,
  processingEnabled,
  transactionHash,
  requestedCapabilities,
}, null, 2));
