import { createPublicClient, http, isAddress, keccak256, parseAbi, zeroAddress } from "viem";

const requireReady = process.argv.includes("--require-ready");
const truthy = (value) => String(value ?? "").trim().toLowerCase() === "true";
const requiredAddress = (name) => {
  const value = String(process.env[name] ?? "").trim();
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is missing or invalid`);
  return value;
};

const automaticEnabled = truthy(process.env.AUTOMATED_BUYBACK_BURN_ENABLED);
const manualEnabled = truthy(process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED);
if (automaticEnabled) throw new Error("Automatic processing must remain disabled during private testing");
if (requireReady && !manualEnabled) throw new Error("Private manual testing is not enabled");

const tokenAllowlist = [...new Set(String(process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    if (!isAddress(value, { strict: false })) throw new Error(`Invalid manual-test token address: ${value}`);
    return value.toLowerCase();
  }))];
if (requireReady && tokenAllowlist.length === 0) throw new Error("Manual testing requires at least one explicitly allowlisted existing token");

if (!manualEnabled) {
  console.log(JSON.stringify({ automaticEnabled, manualEnabled, tokenAllowlist, status: "safely_disabled" }, null, 2));
  process.exit(0);
}

const rpcUrl = String(process.env.ROBINHOOD_RPC_URL ?? "").trim();
if (!/^https?:\/\//i.test(rpcUrl)) throw new Error("ROBINHOOD_RPC_URL is missing or invalid");
const control = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const factory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
const implementation = requiredAddress("AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS");
const adapter = requiredAddress("AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS");
const nativeExecutor = requiredAddress("AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS");
const pairedExecutor = requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS");
const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const keeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
const quoteAuthorizer = requiredAddress("AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS");
const guardian = requiredAddress("AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS");
const expectedPonsFactory = requiredAddress("PONS_V2_FACTORY_ADDRESS");
const expectedUniversalRouter = requiredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS");
const expectedV3Router = requiredAddress("AUTOMATED_FEE_V3_ROUTER_ADDRESS");
const expectedWeth = requiredAddress("AUTOMATED_FEE_WETH_ADDRESS");
const expectedPonsbot = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";

const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
if (await client.getChainId() !== 4663) throw new Error("Robinhood RPC chain mismatch");
const codeAddresses = { control, factory, implementation, adapter, nativeExecutor, pairedExecutor, ...Object.fromEntries(tokenAllowlist.map((token, index) => [`token_${index + 1}`, token])) };
for (const [label, address] of Object.entries(codeAddresses)) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

const controlAbi = parseAbi([
  "function processingEnabled() view returns (bool)",
  "function admin() view returns (address)",
  "function keeper() view returns (address)",
  "function quoteAuthorizer() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function executionAdapter() view returns (address)",
]);
const factoryAbi = parseAbi([
  "function implementation() view returns (address)",
  "function feeControl() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function ponsbot() view returns (address)",
  "function vaultOf(address token) view returns (address)",
  "function approvedFeeEscrow(address ponsFactoryAddress) view returns (address)",
]);
const ponsFactoryAbi = parseAbi(["function feeEscrow() view returns (address)"]);
const adapterAbi = parseAbi([
  "function vaultFactory() view returns (address)",
  "function feeControl() view returns (address)",
  "function canonicalPonsbot() view returns (address)",
  "function allowedExecutor(address executor) view returns (bool)",
  "function allowedExecutorCodeHash(address executor) view returns (bytes32)",
]);
const nativeExecutorAbi = parseAbi([
  "function adapter() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function universalRouter() view returns (address)",
  "function canonicalPonsbot() view returns (address)",
  "function ponsFactoryCodeHash() view returns (bytes32)",
  "function universalRouterCodeHash() view returns (bytes32)",
  "function canonicalPonsbotCodeHash() view returns (bytes32)",
  "function canonicalHook() view returns (address)",
  "function canonicalHookCodeHash() view returns (bytes32)",
]);
const pairedExecutorAbi = parseAbi([
  "function adapter() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function universalRouter() view returns (address)",
  "function permit2() view returns (address)",
  "function v3Router() view returns (address)",
  "function weth() view returns (address)",
  "function feeControl() view returns (address)",
  "function canonicalPonsbot() view returns (address)",
  "function ponsFactoryCodeHash() view returns (bytes32)",
  "function universalRouterCodeHash() view returns (bytes32)",
  "function permit2CodeHash() view returns (bytes32)",
  "function v3RouterCodeHash() view returns (bytes32)",
  "function wethCodeHash() view returns (bytes32)",
  "function feeControlCodeHash() view returns (bytes32)",
  "function ponsbotCodeHash() view returns (bytes32)",
  "function canonicalHook() view returns (address)",
  "function hookCodeHash() view returns (bytes32)",
  "function pairRoutes(address pairAsset) view returns (uint8 kind,uint24 fee,int24 tickSpacing,address hook,bytes32 hookCodeHash)",
]);
const vaultAbi = parseAbi([
  "function pairAsset() view returns(address)",
  "function ponsFactory() view returns(address)",
  "function feeEscrow() view returns(address)",
]);

const [processingEnabled, liveAdmin, liveKeeper, liveQuoteAuthorizer, liveGuardian, liveAdapter, liveImplementation, factoryControl, factoryPons, factoryEscrow, factoryPonsbot, expectedEscrow, adapterFactory, adapterControl, canonicalPonsbot, executorAllowed, executorCodeHash, executorAdapter, executorPonsFactory, executorRouter, executorPonsbot, pinnedPonsFactoryCodeHash, pinnedRouterCodeHash, pinnedPonsbotCodeHash, canonicalHook, pinnedHookCodeHash] = await Promise.all([
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "admin" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "keeper" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "quoteAuthorizer" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "pauseGuardian" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "executionAdapter" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "implementation" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeControl" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "ponsFactory" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "ponsbot" }),
  client.readContract({ address: expectedPonsFactory, abi: ponsFactoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "vaultFactory" }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "feeControl" }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "canonicalPonsbot" }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "allowedExecutor", args: [nativeExecutor] }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "allowedExecutorCodeHash", args: [nativeExecutor] }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "adapter" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "ponsFactory" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "universalRouter" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "canonicalPonsbot" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "ponsFactoryCodeHash" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "universalRouterCodeHash" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "canonicalPonsbotCodeHash" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "canonicalHook" }),
  client.readContract({ address: nativeExecutor, abi: nativeExecutorAbi, functionName: "canonicalHookCodeHash" }),
]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
if (!same(liveAdmin, admin)) throw new Error("Configured admin does not match on-chain control state");
if (!same(liveKeeper, keeper)) throw new Error("Configured keeper does not match on-chain control state");
if (!same(liveQuoteAuthorizer, quoteAuthorizer)) throw new Error("Configured quote authorizer does not match on-chain control state");
if (!same(liveGuardian, guardian)) throw new Error("Configured guardian does not match on-chain control state");
if (!same(liveAdapter, adapter)) throw new Error("Configured adapter does not match on-chain control state");
if (!same(liveImplementation, implementation)) throw new Error("Configured implementation does not match factory state");
if (!same(factoryControl, control) || !same(adapterControl, control) || !same(adapterFactory, factory)) {
  throw new Error("Automated fee contract dependency graph is inconsistent");
}
if (!same(factoryPons, expectedPonsFactory) || !same(factoryEscrow, expectedEscrow)
  || !same(factoryPonsbot, expectedPonsbot) || !same(canonicalPonsbot, expectedPonsbot)) {
  throw new Error("Automated fee contracts do not pin the expected live Pons dependencies");
}
if (!same(executorAdapter, adapter) || !same(executorPonsFactory, expectedPonsFactory)
  || !same(executorRouter, expectedUniversalRouter) || !same(executorPonsbot, expectedPonsbot)) {
  throw new Error("Native buyback executor does not pin the expected adapter, Pons factory, router, and PONSBOT");
}
const [livePonsFactoryCode, liveRouterCode, livePonsbotCode, liveHookCode] = await Promise.all([
  client.getCode({ address: expectedPonsFactory }),
  client.getCode({ address: expectedUniversalRouter }),
  client.getCode({ address: expectedPonsbot }),
  client.getCode({ address: canonicalHook }),
]);
if (!livePonsFactoryCode || !liveRouterCode || !livePonsbotCode || !liveHookCode
  || pinnedPonsFactoryCodeHash !== keccak256(livePonsFactoryCode)
  || pinnedRouterCodeHash !== keccak256(liveRouterCode)
  || pinnedPonsbotCodeHash !== keccak256(livePonsbotCode)
  || pinnedHookCodeHash !== keccak256(liveHookCode)) {
  throw new Error("Native executor dependency bytecode pins do not match the live contracts");
}
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
for (const [label, address] of Object.entries({ expectedPonsFactory, expectedUniversalRouter })) {
  const [implementationSlot, beaconSlot] = await Promise.all([
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT }),
  ]);
  const populated = (value) => value && BigInt(value) !== 0n;
  if (populated(implementationSlot) || populated(beaconSlot)) {
    throw new Error(`${label} is an upgradeable EIP-1967 dependency and is not safely pinned`);
  }
}
const deployedExecutorCode = await client.getCode({ address: nativeExecutor });
if (!executorAllowed || !deployedExecutorCode || executorCodeHash !== keccak256(deployedExecutorCode)) {
  throw new Error("Native buyback executor is not active with its deployed bytecode pinned in the adapter");
}

const [pairedAllowed, pairedAllowedCodeHash, pairedAdapter, pairedFactory, pairedRouter, pairedPermit2,
  pairedV3Router, pairedWeth, pairedControl, pairedPonsbot, pairedFactoryHash, pairedRouterHash, pairedPermit2Hash,
  pairedV3RouterHash, pairedWethHash, pairedControlHash, pairedPonsbotHash,
  pairedHook, pairedHookHash] = await Promise.all([
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "allowedExecutor", args: [pairedExecutor] }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "allowedExecutorCodeHash", args: [pairedExecutor] }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "adapter" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "ponsFactory" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "universalRouter" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "permit2" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "v3Router" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "weth" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "feeControl" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "canonicalPonsbot" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "ponsFactoryCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "universalRouterCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "permit2CodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "v3RouterCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "wethCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "feeControlCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "ponsbotCodeHash" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "canonicalHook" }),
  client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "hookCodeHash" }),
]);
const expectedPermit2 = requiredAddress("PONS_PERMIT2_ADDRESS");
if (!same(pairedAdapter, adapter) || !same(pairedFactory, expectedPonsFactory)
  || !same(pairedRouter, expectedUniversalRouter) || !same(pairedPermit2, expectedPermit2)
  || !same(pairedV3Router, expectedV3Router) || !same(pairedWeth, expectedWeth) || !same(pairedControl, control)
  || !same(pairedPonsbot, expectedPonsbot)) {
  throw new Error("Paired buyback executor dependency graph is inconsistent");
}
const [pairedCode, permit2Code, v3RouterCode, wethCode, controlCode, pairedHookCode] = await Promise.all([
  client.getCode({ address: pairedExecutor }), client.getCode({ address: expectedPermit2 }),
  client.getCode({ address: expectedV3Router }), client.getCode({ address: expectedWeth }), client.getCode({ address: control }),
  client.getCode({ address: pairedHook }),
]);
if (!pairedAllowed || !pairedCode || !permit2Code || !v3RouterCode || !wethCode || !controlCode || !pairedHookCode
  || pairedAllowedCodeHash !== keccak256(pairedCode)
  || pairedFactoryHash !== keccak256(livePonsFactoryCode)
  || pairedRouterHash !== keccak256(liveRouterCode)
  || pairedPermit2Hash !== keccak256(permit2Code)
  || pairedV3RouterHash !== keccak256(v3RouterCode)
  || pairedWethHash !== keccak256(wethCode)
  || pairedControlHash !== keccak256(controlCode)
  || pairedPonsbotHash !== keccak256(livePonsbotCode)
  || pairedHookHash !== keccak256(pairedHookCode)) {
  throw new Error("Paired executor allowlist or dependency bytecode pins do not match live contracts");
}

const tokenStates = [];
for (const token of tokenAllowlist) {
  const vault = await client.readContract({ address: factory, abi: factoryAbi, functionName: "vaultOf", args: [token] });
  if (vault === zeroAddress) {
    tokenStates.push({ token, vault: null });
    continue;
  }
  const [pairAsset, vaultPonsFactory, vaultFeeEscrow] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "pairAsset" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "ponsFactory" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "feeEscrow" }),
  ]);
  const approvedVaultEscrow = await client.readContract({
    address: factory, abi: factoryAbi, functionName: "approvedFeeEscrow", args: [vaultPonsFactory],
  });
  if (!same(approvedVaultEscrow, vaultFeeEscrow)) {
    throw new Error(`Vault ${vault} uses a Pons factory/escrow stack that is no longer approved`);
  }
  let pairRouteKind = null;
  if (pairAsset !== zeroAddress) {
    const route = await client.readContract({ address: pairedExecutor, abi: pairedExecutorAbi, functionName: "pairRoutes", args: [pairAsset] });
    pairRouteKind = Number(route[0]);
    if (pairRouteKind !== 1 && pairRouteKind !== 2) throw new Error(`No paired buyback route is configured for ${pairAsset}`);
  }
  tokenStates.push({ token, vault, pairAsset, ponsFactory: vaultPonsFactory, feeEscrow: vaultFeeEscrow, pairRouteKind });
}

console.log(JSON.stringify({
  status: processingEnabled ? "manual_processing_enabled" : "manual_ready_processing_paused",
  automaticEnabled,
  manualEnabled,
  processingEnabled,
  control,
  factory,
  implementation,
  adapter,
  nativeExecutor,
  admin,
  keeper,
  quoteAuthorizer,
  guardian,
  canonicalPonsbot,
  tokens: tokenStates,
}, null, 2));
