import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
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
const MANIFEST_VERSION = 1;
const CONFIRMATIONS = 2;
const GAS_MARGIN_PERCENT = 120n;
const MAX_FEE_MULTIPLIER = 2n;
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmationIndex = args.indexOf("--confirm");
const suppliedConfirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";
if (confirmationIndex >= 0 && (!suppliedConfirmation || suppliedConfirmation.startsWith("--"))) {
  throw new Error("--confirm requires the exact plan token printed by dry-run mode");
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

function planToken(value) {
  return keccak256(stringToHex(JSON.stringify(stable(value))));
}

const activationFlags = [
  "AUTOMATED_BUYBACK_BURN_ENABLED",
  "AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED",
  "AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED",
  "AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED",
  "AUTOMATED_FEE_BOT_COMMANDS_ENABLED",
];
const activeFlags = activationFlags.filter(enabled);
if (activeFlags.length > 0) {
  throw new Error(`pair-route configuration requires rollout flags to be false: ${activeFlags.join(", ")}`);
}

const rawCatalog = JSON.parse(await readFile(new URL("../lib/pons-pair-catalog.json", import.meta.url), "utf8"));
if (!Array.isArray(rawCatalog) || rawCatalog.length === 0) throw new Error("reviewed pair-route catalog is empty");
const routes = rawCatalog.map((entry, index) => {
  if (!entry || typeof entry !== "object" || typeof entry.symbol !== "string" || !entry.route) {
    throw new Error(`pair-route catalog entry ${index + 1} is malformed`);
  }
  if (!isAddress(entry.address, { strict: false }) || !isAddress(entry.route.hook, { strict: false })) {
    throw new Error(`pair-route catalog entry ${entry.symbol} has an invalid address`);
  }
  const kind = entry.route.kind;
  const fee = Number(entry.route.fee);
  const tickSpacing = Number(entry.route.tickSpacing);
  const hook = getAddress(entry.route.hook);
  if (!/^[A-Za-z0-9]{1,16}$/.test(entry.symbol) || !["v3", "v4"].includes(kind)
    || !Number.isInteger(fee) || fee <= 0 || fee > 0xffffff
    || !Number.isInteger(tickSpacing) || tickSpacing < -0x800000 || tickSpacing > 0x7fffff) {
    throw new Error(`pair-route catalog entry ${entry.symbol} has invalid route parameters`);
  }
  if (kind === "v3" && (tickSpacing !== 0 || hook !== zeroAddress)) {
    throw new Error(`V3 route ${entry.symbol} must use zero tick spacing and hook`);
  }
  if (kind === "v4" && tickSpacing === 0) throw new Error(`V4 route ${entry.symbol} requires tick spacing`);
  return { pairAsset: getAddress(entry.address), symbol: entry.symbol, kind, fee, tickSpacing, hook };
});
if (new Set(routes.map((route) => route.symbol.toLowerCase())).size !== routes.length
  || new Set(routes.map((route) => route.pairAsset.toLowerCase())).size !== routes.length) {
  throw new Error("reviewed pair-route catalog contains duplicate symbols or assets");
}

const control = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const executor = requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS");
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const controlAbi = parseAbi([
  "function processingEnabled() view returns (bool)",
  "function admin() view returns (address)",
]);
const executorAbi = parseAbi([
  "function feeControl() view returns (address)",
  "function pairRoutes(address pairAsset) view returns (uint8 kind,uint24 fee,int24 tickSpacing,address hook,bytes32 hookCodeHash)",
  "function configurePairRoute(address pairAsset,uint8 kind,uint24 fee,int24 tickSpacing,address hook)",
]);
const [processingEnabled, liveAdmin, liveControl, controlCode, executorCode, pairCode] = await Promise.all([
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "admin" }),
  client.readContract({ address: executor, abi: executorAbi, functionName: "feeControl" }),
  client.getCode({ address: control }),
  client.getCode({ address: executor }),
  Promise.all(routes.map((route) => client.getCode({ address: route.pairAsset }))),
]);
if (processingEnabled) throw new Error("on-chain processing must be paused before configuring pair routes");
if (liveAdmin.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee control admin does not match configuration");
if (liveControl.toLowerCase() !== control.toLowerCase()) throw new Error("paired executor is bound to a different fee control");
if (!controlCode || controlCode === "0x" || !executorCode || executorCode === "0x") throw new Error("automated fee control or paired executor is not deployed");
pairCode.forEach((code, index) => {
  if (!code || code === "0x") throw new Error(`${routes[index].symbol} pair asset has no deployed bytecode`);
});

async function expectedHookHash(route) {
  if (route.hook === zeroAddress) return `0x${"0".repeat(64)}`;
  const code = await client.getCode({ address: route.hook });
  if (!code || code === "0x") throw new Error(`${route.symbol} hook has no deployed bytecode`);
  return keccak256(code);
}

function normalizedState(value) {
  return {
    kind: Number(value[0]), fee: Number(value[1]), tickSpacing: Number(value[2]),
    hook: getAddress(value[3]), hookCodeHash: value[4],
  };
}

async function readRoute(route) {
  const [value, hookCodeHash] = await Promise.all([
    client.readContract({ address: executor, abi: executorAbi, functionName: "pairRoutes", args: [route.pairAsset] }),
    expectedHookHash(route),
  ]);
  const current = normalizedState(value);
  const expectedKind = route.kind === "v3" ? 1 : 2;
  const matches = current.kind === expectedKind && current.fee === route.fee
    && current.tickSpacing === route.tickSpacing && current.hook.toLowerCase() === route.hook.toLowerCase()
    && current.hookCodeHash.toLowerCase() === hookCodeHash.toLowerCase();
  return { ...route, expectedKind, expectedHookCodeHash: hookCodeHash, current, matches };
}

const inspected = await Promise.all(routes.map(readRoute));
const pending = inspected.filter((route) => !route.matches);

function configurationData(route) {
  return encodeFunctionData({
    abi: executorAbi,
    functionName: "configurePairRoute",
    args: [route.pairAsset, route.expectedKind, route.fee, route.tickSpacing, route.hook],
  });
}

async function boundedMap(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

// A dry run is a real eth_call and gas estimate for every pending route, not
// merely a catalog printout. Keep concurrency bounded so configuring the
// contracts does not create a large burst against the production RPC.
const simulations = await boundedMap(pending, 4, async (route) => {
  const data = configurationData(route);
  await client.call({ account: admin, to: executor, data });
  const estimatedGas = await client.estimateGas({ account: admin, to: executor, data });
  return { symbol: route.symbol, estimatedGas };
});
const simulatedGasBySymbol = new Map(simulations.map((simulation) => [simulation.symbol, simulation.estimatedGas]));
const identity = {
  version: MANIFEST_VERSION,
  chainId: CHAIN_ID,
  admin,
  control,
  executor,
  routes: pending.map(({ pairAsset, symbol, kind, fee, tickSpacing, hook }) => ({
    pairAsset, symbol, kind, fee, tickSpacing, hook,
  })),
};
const confirmationToken = planToken(identity);
const manifestPath = resolve(process.cwd(), ".deployment-private", "automated-fee-pair-routes.json");
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  manifest = { version: MANIFEST_VERSION, chainId: CHAIN_ID, control, executor, admin, transactions: {} };
}
if (manifest.version !== MANIFEST_VERSION || manifest.chainId !== CHAIN_ID
  || manifest.control?.toLowerCase() !== control.toLowerCase()
  || manifest.executor?.toLowerCase() !== executor.toLowerCase()
  || manifest.admin?.toLowerCase() !== admin.toLowerCase()
  || !manifest.transactions || typeof manifest.transactions !== "object") {
  throw new Error("pair-route manifest does not match the deployed automated fee infrastructure");
}

async function persistManifest() {
  await mkdir(dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, manifestPath);
}

const [balance, feeEstimate] = await Promise.all([
  client.getBalance({ address: admin }),
  client.estimateFeesPerGas(),
]);
const baseMaxFee = feeEstimate.maxFeePerGas ?? feeEstimate.gasPrice;
if (!baseMaxFee) throw new Error("RPC did not return a usable gas fee");
const conservativeGas = simulations.reduce(
  (total, simulation) => total + (simulation.estimatedGas * GAS_MARGIN_PERCENT / 100n),
  0n,
);
const conservativeRequired = conservativeGas * baseMaxFee * MAX_FEE_MULTIPLIER;
const summary = {
  mode: execute ? "guarded_execution" : "dry_run",
  mutationSent: false,
  chainId: CHAIN_ID,
  processingEnabled,
  admin,
  control,
  executor,
  totalRoutes: routes.length,
  alreadyConfigured: routes.length - pending.length,
  routesToConfigure: pending.map(({ symbol, pairAsset, kind, fee, tickSpacing, hook, current }) => ({
    symbol, pairAsset, kind, fee, tickSpacing, hook, current,
    estimatedGas: simulatedGasBySymbol.get(symbol)?.toString(),
  })),
  balanceWei: balance.toString(),
  balanceEth: formatEther(balance),
  conservativeRequiredWei: conservativeRequired.toString(),
  conservativeRequiredEth: formatEther(conservativeRequired),
  confirmationToken,
  manifestPath,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  if (pending.length === 0) console.log("All reviewed pair routes are already configured. No transaction is needed.");
  else {
    if (balance < conservativeRequired) console.log("WARNING: admin balance is below the conservative route-configuration ceiling.");
    console.log(`No transaction was signed or broadcast. To configure this exact route set, pass --execute --confirm ${confirmationToken}`);
  }
  process.exit(0);
}
if (pending.length === 0) {
  console.log(JSON.stringify({ status: "all_pair_routes_already_configured", mutationSent: false, totalRoutes: routes.length }, null, 2));
  process.exit(0);
}
if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) {
  throw new Error("pair-route confirmation token does not match the current dry-run plan");
}
if (balance < conservativeRequired) throw new Error("automated fee admin balance is below the conservative route-configuration requirement");

const cdp = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const accountName = process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin";
if (!/^[A-Za-z0-9_-]{3,80}$/.test(accountName)) throw new Error("AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME is invalid");
const account = await cdp.evm.getOrCreateAccount({ name: accountName });
if (account.address.toLowerCase() !== admin.toLowerCase()) throw new Error("automated fee admin CDP account mismatch");

async function transactionExists(hash) {
  try { return Boolean(await client.getTransaction({ hash })); } catch { return false; }
}

async function submitSigned(signed, localHash) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await transactionExists(localHash)) return localHash;
    try {
      const submitted = await client.sendRawTransaction({ serializedTransaction: signed });
      if (submitted.toLowerCase() !== localHash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
      return submitted;
    } catch (error) {
      lastError = error;
      if (await transactionExists(localHash)) return localHash;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC rejected the signed pair-route transaction");
}

function assertSignedRoute(signed, route, expectedNonce) {
  return Promise.all([
    recoverTransactionAddress({ serializedTransaction: signed }),
    Promise.resolve(parseTransaction(signed)),
  ]).then(([sender, parsed]) => {
    if (sender.toLowerCase() !== admin.toLowerCase() || parsed.chainId !== CHAIN_ID
      || Number(parsed.nonce) !== expectedNonce || parsed.to?.toLowerCase() !== executor.toLowerCase()
      || (parsed.value ?? 0n) !== 0n || !parsed.data) {
      throw new Error(`${route.symbol} signed transaction envelope mismatch`);
    }
    const decoded = decodeFunctionData({ abi: executorAbi, data: parsed.data });
    if (decoded.functionName !== "configurePairRoute"
      || decoded.args[0].toLowerCase() !== route.pairAsset.toLowerCase()
      || Number(decoded.args[1]) !== route.expectedKind || Number(decoded.args[2]) !== route.fee
      || Number(decoded.args[3]) !== route.tickSpacing || decoded.args[4].toLowerCase() !== route.hook.toLowerCase()) {
      throw new Error(`${route.symbol} signed route calldata mismatch`);
    }
    return parsed;
  });
}

async function recoverOrSubmit(route, record) {
  await assertSignedRoute(record.signedTransaction, route, record.nonce);
  const localHash = keccak256(record.signedTransaction);
  if (localHash.toLowerCase() !== record.transactionHash.toLowerCase()) throw new Error(`${route.symbol} manifest transaction hash mismatch`);
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: localHash }); } catch { receipt = null; }
  if (!receipt) {
    const pendingNonce = await client.getTransactionCount({ address: admin, blockTag: "pending" });
    if (!(await transactionExists(localHash)) && pendingNonce > record.nonce) {
      throw new Error(`${route.symbol} signed transaction nonce was consumed by another transaction; inspect the admin account before continuing`);
    }
    await submitSigned(record.signedTransaction, localHash);
    receipt = await client.waitForTransactionReceipt({ hash: localHash, confirmations: CONFIRMATIONS, timeout: 180_000 });
  }
  if (receipt.status !== "success") throw new Error(`${route.symbol} route-configuration transaction reverted`);
  return { hash: localHash, receipt };
}

let configuredThisRun = 0;
for (const route of pending) {
  if (await client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" })) {
    throw new Error("on-chain processing became enabled during route configuration");
  }
  const fresh = await readRoute(route);
  if (fresh.matches) continue;
  let record = manifest.transactions[route.pairAsset.toLowerCase()];
  let result;
  if (record?.status === "signed" || record?.status === "broadcast") {
    result = await recoverOrSubmit(route, record);
  } else {
    const data = configurationData(route);
    await client.call({ account: admin, to: executor, data });
    const [estimatedGas, currentFees, nonce, currentBalance] = await Promise.all([
      client.estimateGas({ account: admin, to: executor, data }),
      client.estimateFeesPerGas(),
      client.getTransactionCount({ address: admin, blockTag: "pending" }),
      client.getBalance({ address: admin }),
    ]);
    const currentBaseFee = currentFees.maxFeePerGas ?? currentFees.gasPrice;
    if (!currentBaseFee) throw new Error("RPC did not return a usable transaction fee");
    const gas = estimatedGas * GAS_MARGIN_PERCENT / 100n;
    const maxFeePerGas = currentBaseFee * MAX_FEE_MULTIPLIER;
    if (currentBalance < gas * maxFeePerGas) throw new Error("automated fee admin has insufficient ETH");
    const transaction = {
      chainId: CHAIN_ID,
      type: "eip1559",
      to: executor,
      data,
      value: 0n,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas: currentFees.maxPriorityFeePerGas,
    };
    const { signature } = await cdp.evm.signTransaction({
      address: admin,
      transaction: serializeTransaction(transaction),
      idempotencyKey: `automated-fee-pair-route:v1:${confirmationToken}:${route.symbol}`,
    });
    await assertSignedRoute(signature, route, nonce);
    record = {
      symbol: route.symbol,
      pairAsset: route.pairAsset,
      nonce,
      transactionHash: keccak256(signature),
      signedTransaction: signature,
      status: "signed",
      signedAt: new Date().toISOString(),
    };
    manifest.transactions[route.pairAsset.toLowerCase()] = record;
    await persistManifest();
    result = await recoverOrSubmit(route, record);
  }
  record.status = "confirmed";
  record.blockNumber = result.receipt.blockNumber.toString();
  record.confirmedAt = new Date().toISOString();
  await persistManifest();
  const verified = await readRoute(route);
  if (!verified.matches) throw new Error(`${route.symbol} route failed its post-transaction verification`);
  configuredThisRun += 1;
  console.log(`${configuredThisRun}/${pending.length} confirmed: ${route.symbol} at ${route.pairAsset}`);
}

const finalRoutes = await Promise.all(routes.map(readRoute));
const missing = finalRoutes.filter((route) => !route.matches).map((route) => route.symbol);
if (missing.length > 0) throw new Error(`route configuration incomplete: ${missing.join(", ")}`);
console.log(JSON.stringify({
  status: "all_pair_routes_configured_processing_paused",
  mutationSent: configuredThisRun > 0,
  processingEnabled: false,
  totalRoutes: routes.length,
  configuredThisRun,
  manifestPath,
}, null, 2));
