import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseSignature,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  stringToHex,
} from "viem";

const CHAIN_ID = 4663;
const PONSBOT = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";
const DEFAULT_PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const DEFAULT_V3_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const DEFAULT_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MANIFEST_VERSION = 1;
const CONFIRMATIONS = 2;
const GAS_LIMIT_MARGIN = 120n;
const MAX_FEE_MARGIN = 2n;
// Conservative preflight ceilings. Actual transactions are still simulated
// and estimated immediately before signing. These ceilings only prevent a
// deployment from starting with an obviously underfunded administrator.
const DEPLOYMENT_GAS_CEILINGS = [1_500_000n, 4_500_000n, 2_000_000n, 2_500_000n, 3_500_000n, 5_000_000n];
const CONFIGURATION_GAS_CEILING = 750_000n;

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

function requiredAddress(name, fallback = "") {
  const value = String(process.env[name] ?? fallback).trim();
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is missing or invalid`);
  return getAddress(value);
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

function gasEnvelope(estimatedGas, maxFeePerGas) {
  return {
    gas: estimatedGas * GAS_LIMIT_MARGIN / 100n,
    maxFeePerGas: maxFeePerGas * MAX_FEE_MARGIN,
  };
}

async function artifact(name) {
  const [abiText, bytecodeText, runtimeText] = await Promise.all([
    readFile(new URL(`../contracts/build-check/${name}.abi`, import.meta.url), "utf8"),
    readFile(new URL(`../contracts/build-check/${name}.bin`, import.meta.url), "utf8"),
    readFile(new URL(`../contracts/build-check/${name}.bin-runtime`, import.meta.url), "utf8"),
  ]);
  const bytecode = `0x${bytecodeText.trim()}`;
  const runtimeBytecode = `0x${runtimeText.trim()}`;
  if (bytecode === "0x" || runtimeBytecode === "0x") throw new Error(`${name} artifact is empty; compile first`);
  return {
    abi: JSON.parse(abiText),
    bytecode,
    runtimeBytecode,
    creationHash: keccak256(bytecode),
    runtimeArtifactHash: keccak256(runtimeBytecode),
  };
}

const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

const addresses = {
  admin: requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS"),
  guardian: requiredAddress("AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS"),
  keeper: requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS"),
  quoteAuthorizer: requiredAddress("AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS"),
  ponsFactory: requiredAddress("PONS_V2_FACTORY_ADDRESS", DEFAULT_PONS_FACTORY),
  universalRouter: requiredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS"),
  permit2: requiredAddress("PONS_PERMIT2_ADDRESS"),
  v3Router: requiredAddress("AUTOMATED_FEE_V3_ROUTER_ADDRESS", DEFAULT_V3_ROUTER),
  weth: requiredAddress("AUTOMATED_FEE_WETH_ADDRESS", DEFAULT_WETH),
  ponsbot: getAddress(PONSBOT),
};
if (new Set([addresses.admin, addresses.guardian, addresses.keeper, addresses.quoteAuthorizer].map((value) => value.toLowerCase())).size !== 4) {
  throw new Error("automated fee privileged roles must use distinct addresses");
}
for (const role of ["admin", "guardian", "keeper", "quoteAuthorizer"]) {
  const code = await client.getCode({ address: addresses[role] });
  if (code && code !== "0x") throw new Error(`${role} must be an EOA`);
}

const ponsFactoryAbi = parseAbi(["function feeEscrow() view returns (address)"]);
const feeEscrow = getAddress(await client.readContract({
  address: addresses.ponsFactory,
  abi: ponsFactoryAbi,
  functionName: "feeEscrow",
}));
for (const [label, address] of Object.entries({
  ponsFactory: addresses.ponsFactory,
  feeEscrow,
  universalRouter: addresses.universalRouter,
  permit2: addresses.permit2,
  v3Router: addresses.v3Router,
  weth: addresses.weth,
  ponsbot: addresses.ponsbot,
})) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode`);
}

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
for (const [label, address] of Object.entries({ ponsFactory: addresses.ponsFactory, universalRouter: addresses.universalRouter })) {
  const [implementation, beacon] = await Promise.all([
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT }),
  ]);
  if ((implementation && BigInt(implementation) !== 0n) || (beacon && BigInt(beacon) !== 0n)) {
    throw new Error(`${label} is an upgradeable EIP-1967 dependency and is not safely pinned`);
  }
}

const cdp = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const adminAccountName = process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin";
if (!/^[A-Za-z0-9_-]{3,80}$/.test(adminAccountName)) throw new Error("AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME is invalid");
const adminAccount = await cdp.evm.getOrCreateAccount({ name: adminAccountName });
if (adminAccount.address.toLowerCase() !== addresses.admin.toLowerCase()) {
  throw new Error("configured automated fee admin does not match its CDP account");
}

const artifacts = Object.fromEntries(await Promise.all([
  "PonsBotFeeControl",
  "PonsBotFeeVault",
  "PonsBotFeeVaultFactory",
  "PonsBotBuybackAdapter",
  "PonsBotNativeBuybackExecutor",
  "PonsBotPairedBuybackExecutor",
].map(async (name) => [name, await artifact(name)])));

const manifestPath = resolve(process.cwd(), ".deployment-private", "automated-fee-core.json");
let manifest = null;
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (manifest && manifest.version !== MANIFEST_VERSION) throw new Error("deployment manifest version is unsupported");

const pendingNonce = await client.getTransactionCount({ address: addresses.admin, blockTag: "pending" });
const initialNonce = manifest?.initialNonce ?? pendingNonce;
if (!Number.isSafeInteger(initialNonce) || initialNonce < 0) throw new Error("deployment manifest nonce is invalid");
const predicted = Array.from({ length: 6 }, (_, offset) => getContractAddress({ from: addresses.admin, nonce: BigInt(initialNonce + offset) }));
const definitions = [
  ["PonsBotFeeControl", [addresses.admin, addresses.guardian, addresses.keeper, addresses.quoteAuthorizer]],
  ["PonsBotFeeVault", []],
  ["PonsBotFeeVaultFactory", [predicted[1], predicted[0], addresses.ponsFactory, feeEscrow, addresses.ponsbot]],
  ["PonsBotBuybackAdapter", [predicted[2], predicted[0], addresses.ponsbot]],
  ["PonsBotNativeBuybackExecutor", [predicted[3], addresses.ponsFactory, addresses.universalRouter, addresses.ponsbot]],
  ["PonsBotPairedBuybackExecutor", [
    predicted[3], addresses.ponsFactory, addresses.universalRouter, addresses.permit2,
    addresses.v3Router, addresses.weth, predicted[0], addresses.ponsbot,
  ]],
].map(([name, constructorArgs], index) => {
  const artifactValue = artifacts[name];
  const data = encodeDeployData({ abi: artifactValue.abi, bytecode: artifactValue.bytecode, args: constructorArgs });
  return {
    order: index + 1,
    name,
    nonce: initialNonce + index,
    address: getAddress(predicted[index]),
    constructorArgs,
    data,
    initCodeHash: keccak256(data),
    creationArtifactHash: artifactValue.creationHash,
    runtimeArtifactHash: artifactValue.runtimeArtifactHash,
  };
});

const planIdentity = {
  version: MANIFEST_VERSION,
  chainId: CHAIN_ID,
  admin: addresses.admin,
  initialNonce,
  dependencies: { ...addresses, feeEscrow },
  steps: definitions.map(({ order, name, nonce, address, constructorArgs, initCodeHash, creationArtifactHash, runtimeArtifactHash }) => ({
    order, name, nonce, address, constructorArgs, initCodeHash, creationArtifactHash, runtimeArtifactHash,
  })),
};
const confirmationToken = planToken(planIdentity);
if (manifest?.confirmationToken && manifest.confirmationToken.toLowerCase() !== confirmationToken.toLowerCase()) {
  throw new Error("current artifacts, dependencies, roles, or predicted addresses do not match the deployment manifest");
}

const completed = manifest?.steps?.filter((step) => step.status === "confirmed") ?? [];
const completedConfiguration = manifest?.configuration?.length ?? 0;
const expectedPendingNonce = initialNonce + completed.length + completedConfiguration;
if (pendingNonce !== expectedPendingNonce) {
  throw new Error(`admin pending nonce ${pendingNonce} does not match resumable deployment position ${expectedPendingNonce}`);
}
for (let index = 0; index < definitions.length; index += 1) {
  const code = await client.getCode({ address: definitions[index].address });
  const recorded = manifest?.steps?.[index];
  if (index < completed.length) {
    if (!recorded || recorded.status !== "confirmed" || !code || code === "0x") {
      throw new Error(`confirmed manifest step ${index + 1} is missing its deployed bytecode`);
    }
    if (recorded.deployedCodeHash !== keccak256(code)) throw new Error(`deployed bytecode changed for step ${index + 1}`);
  } else if (code && code !== "0x") {
    throw new Error(`unexpected bytecode already exists at undeployed predicted address ${definitions[index].address}`);
  }
}

const [balance, fees] = await Promise.all([
  client.getBalance({ address: addresses.admin }),
  client.estimateFeesPerGas(),
]);
const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
if (!maxFeePerGas) throw new Error("RPC did not return a usable fee estimate");
const remainingCeilingGas = DEPLOYMENT_GAS_CEILINGS.slice(completed.length).reduce((sum, value) => sum + value, 0n)
  + (manifest?.configured ? 0n : CONFIGURATION_GAS_CEILING);
const conservativeRequiredWei = remainingCeilingGas * maxFeePerGas * MAX_FEE_MARGIN;

const summary = {
  mode: execute ? "guarded_execution" : "dry_run",
  mutationSent: false,
  chainId: CHAIN_ID,
  admin: addresses.admin,
  adminAccountName,
  pendingNonce,
  initialNonce,
  completedDeployments: completed.length,
  processingExpectedDisabled: true,
  balanceWei: balance.toString(),
  balanceEth: formatEther(balance),
  conservativeRequiredWei: conservativeRequiredWei.toString(),
  conservativeRequiredEth: formatEther(conservativeRequiredWei),
  confirmationToken,
  manifestPath,
  deployments: definitions.map(({ data, ...step }) => ({ ...step, initCodeBytes: (data.length - 2) / 2 })),
  configuration: [
    `PonsBotFeeControl(${predicted[0]}).setExecutionAdapter(${predicted[3]})`,
    `PonsBotBuybackAdapter(${predicted[3]}).setExecutor(${predicted[4]}, true)`,
    `PonsBotBuybackAdapter(${predicted[3]}).setExecutor(${predicted[5]}, true)`,
  ],
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  if (balance < conservativeRequiredWei) {
    console.log("WARNING: the admin balance is below the conservative deployment ceiling; fund it before execution.");
  }
  console.log(`No transaction was signed or broadcast. To execute this exact plan, pass --execute --confirm ${confirmationToken}`);
  process.exit(0);
}
if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("deployment confirmation token does not match this exact plan");
if (balance < conservativeRequiredWei) throw new Error("automated fee admin balance is below the conservative deployment requirement");

async function persistManifest() {
  await mkdir(dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, manifestPath);
}

async function transactionExists(hash) {
  try { return Boolean(await client.getTransaction({ hash })); } catch { return false; }
}

async function sendSigned(signed, localHash) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await transactionExists(localHash)) return localHash;
    try { return await client.sendRawTransaction({ serializedTransaction: signed }); } catch (error) {
      lastError = error;
      if (await transactionExists(localHash)) return localHash;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC rejected the signed deployment transaction");
}

async function signAndConfirm({ nonce, to, data, expectedContractAddress, idempotencyKey }) {
  await client.call({ account: addresses.admin, ...(to ? { to } : {}), data, value: 0n });
  const estimatedGas = await client.estimateGas({ account: addresses.admin, ...(to ? { to } : {}), data, value: 0n });
  const currentFees = await client.estimateFeesPerGas();
  const currentMaxFee = currentFees.maxFeePerGas ?? currentFees.gasPrice;
  if (!currentMaxFee) throw new Error("RPC did not return a usable transaction fee");
  const envelope = gasEnvelope(estimatedGas, currentMaxFee);
  const transaction = {
    chainId: CHAIN_ID,
    type: "eip1559",
    ...(to ? { to } : {}),
    data,
    value: 0n,
    nonce,
    gas: envelope.gas,
    maxFeePerGas: envelope.maxFeePerGas,
    maxPriorityFeePerGas: currentFees.maxPriorityFeePerGas,
  };
  // CDP's signTransaction decoder currently rejects valid EIP-1559 contract
  // creation envelopes because their `to` field is empty. For deployments,
  // ask the dedicated admin account to sign the canonical unsigned transaction
  // hash, then attach and independently recover the signature locally. Calls
  // to existing contracts continue through CDP's stricter transaction parser.
  let signature;
  if (to) {
    ({ signature } = await cdp.evm.signTransaction({
      address: adminAccount.address,
      transaction: serializeTransaction(transaction),
      idempotencyKey,
    }));
  } else {
    const unsignedTransaction = serializeTransaction(transaction);
    const signedHash = await cdp.evm.signHash({
      address: adminAccount.address,
      hash: keccak256(unsignedTransaction),
      // Keep raw-hash signing in a distinct namespace from CDP's transaction
      // signing endpoint. CDP binds an idempotency key to both endpoint and
      // payload, so a parser-rejected signTransaction attempt cannot poison a
      // corrected contract-creation retry.
      idempotencyKey: `${idempotencyKey}:create-hash-v1`,
    });
    signature = serializeTransaction(transaction, parseSignature(signedHash.signature));
  }
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== addresses.admin.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
    || (parsed.to ?? null)?.toLowerCase() !== (to ?? null)?.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== 0n) {
    throw new Error("signed deployment transaction envelope mismatch");
  }
  const localHash = keccak256(signature);
  const submittedHash = await sendSigned(signature, localHash);
  if (submittedHash.toLowerCase() !== localHash.toLowerCase()) throw new Error("RPC returned an unexpected deployment transaction hash");
  const receipt = await client.waitForTransactionReceipt({ hash: localHash, confirmations: CONFIRMATIONS, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${localHash} reverted`);
  if (expectedContractAddress && receipt.contractAddress?.toLowerCase() !== expectedContractAddress.toLowerCase()) {
    throw new Error(`deployment receipt created ${receipt.contractAddress ?? "no contract"}, expected ${expectedContractAddress}`);
  }
  return { hash: localHash, receipt, estimatedGas, transaction };
}

manifest ||= {
  version: MANIFEST_VERSION,
  confirmationToken,
  chainId: CHAIN_ID,
  admin: addresses.admin,
  initialNonce,
  dependencies: planIdentity.dependencies,
  steps: definitions.map((step) => ({ order: step.order, name: step.name, nonce: step.nonce, address: step.address, initCodeHash: step.initCodeHash, status: "pending" })),
  configured: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
await persistManifest();

for (let index = completed.length; index < definitions.length; index += 1) {
  const step = definitions[index];
  if (await client.getTransactionCount({ address: addresses.admin, blockTag: "pending" }) !== step.nonce) {
    throw new Error(`admin nonce changed before ${step.name}`);
  }
  const result = await signAndConfirm({
    nonce: step.nonce,
    data: step.data,
    expectedContractAddress: step.address,
    idempotencyKey: `automated-fee-core:${confirmationToken}:${step.order}`,
  });
  const code = await client.getCode({ address: step.address });
  if (!code || code === "0x") throw new Error(`${step.name} receipt confirmed without deployed code`);
  manifest.steps[index] = {
    ...manifest.steps[index],
    status: "confirmed",
    transactionHash: result.hash,
    blockNumber: result.receipt.blockNumber.toString(),
    gasUsed: result.receipt.gasUsed.toString(),
    deployedCodeHash: keccak256(code),
    confirmedAt: new Date().toISOString(),
  };
  manifest.updatedAt = new Date().toISOString();
  await persistManifest();
  console.log(`${step.order}/6 confirmed: ${step.name} at ${step.address}`);
}

const controlAbi = parseAbi([
  "function setExecutionAdapter(address next)",
  "function executionAdapter() view returns (address)",
  "function processingEnabled() view returns (bool)",
  "function admin() view returns (address)",
  "function keeper() view returns (address)",
  "function quoteAuthorizer() view returns (address)",
  "function pauseGuardian() view returns (address)",
]);
const adapterAbi = parseAbi([
  "function setExecutor(address executor,bool allowed)",
  "function allowedExecutor(address executor) view returns (bool)",
  "function allowedExecutorCodeHash(address executor) view returns (bytes32)",
]);

if (!manifest.configured) {
  const configurationCalls = [
    { to: definitions[0].address, data: encodeFunctionData({ abi: controlAbi, functionName: "setExecutionAdapter", args: [definitions[3].address] }), label: "control adapter" },
    { to: definitions[3].address, data: encodeFunctionData({ abi: adapterAbi, functionName: "setExecutor", args: [definitions[4].address, true] }), label: "native executor" },
    { to: definitions[3].address, data: encodeFunctionData({ abi: adapterAbi, functionName: "setExecutor", args: [definitions[5].address, true] }), label: "paired executor" },
  ];
  manifest.configuration ||= [];
  for (let index = manifest.configuration.length; index < configurationCalls.length; index += 1) {
    const nonce = initialNonce + definitions.length + index;
    if (await client.getTransactionCount({ address: addresses.admin, blockTag: "pending" }) !== nonce) {
      throw new Error(`admin nonce changed before ${configurationCalls[index].label} configuration`);
    }
    const result = await signAndConfirm({
      nonce,
      to: configurationCalls[index].to,
      data: configurationCalls[index].data,
      idempotencyKey: `automated-fee-core:${confirmationToken}:configure:${index + 1}`,
    });
    manifest.configuration.push({ label: configurationCalls[index].label, transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString() });
    manifest.updatedAt = new Date().toISOString();
    await persistManifest();
    console.log(`Configuration confirmed: ${configurationCalls[index].label}`);
  }
}

const [processingEnabled, liveAdmin, liveKeeper, liveQuoteAuthorizer, liveGuardian, liveAdapter, nativeAllowed, pairedAllowed, nativeCodeHash, pairedCodeHash, nativeCode, pairedCode] = await Promise.all([
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "admin" }),
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "keeper" }),
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "quoteAuthorizer" }),
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "pauseGuardian" }),
  client.readContract({ address: definitions[0].address, abi: controlAbi, functionName: "executionAdapter" }),
  client.readContract({ address: definitions[3].address, abi: adapterAbi, functionName: "allowedExecutor", args: [definitions[4].address] }),
  client.readContract({ address: definitions[3].address, abi: adapterAbi, functionName: "allowedExecutor", args: [definitions[5].address] }),
  client.readContract({ address: definitions[3].address, abi: adapterAbi, functionName: "allowedExecutorCodeHash", args: [definitions[4].address] }),
  client.readContract({ address: definitions[3].address, abi: adapterAbi, functionName: "allowedExecutorCodeHash", args: [definitions[5].address] }),
  client.getCode({ address: definitions[4].address }),
  client.getCode({ address: definitions[5].address }),
]);
if (processingEnabled) throw new Error("processing unexpectedly enabled after deployment");
if (liveAdmin.toLowerCase() !== addresses.admin.toLowerCase() || liveKeeper.toLowerCase() !== addresses.keeper.toLowerCase()
  || liveQuoteAuthorizer.toLowerCase() !== addresses.quoteAuthorizer.toLowerCase() || liveGuardian.toLowerCase() !== addresses.guardian.toLowerCase()
  || liveAdapter.toLowerCase() !== definitions[3].address.toLowerCase() || !nativeAllowed || !pairedAllowed
  || !nativeCode || !pairedCode || nativeCodeHash !== keccak256(nativeCode) || pairedCodeHash !== keccak256(pairedCode)) {
  throw new Error("post-deployment role, adapter, or executor verification failed");
}
manifest.configured = true;
manifest.processingEnabled = false;
manifest.completedAt = new Date().toISOString();
manifest.updatedAt = manifest.completedAt;
await persistManifest();
console.log(JSON.stringify({
  status: "deployed_configured_paused",
  mutationSent: true,
  confirmationToken,
  manifestPath,
  processingEnabled: false,
  addresses: Object.fromEntries(definitions.map((step) => [step.name, step.address])),
}, null, 2));
