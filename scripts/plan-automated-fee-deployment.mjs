import { readFile } from "node:fs/promises";
import { createPublicClient, encodeDeployData, getContractAddress, http, isAddress, keccak256, parseAbi } from "viem";

const CHAIN_ID = 4663;
const PONSBOT = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";
const DEFAULT_PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ponsFactory = process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_PONS_FACTORY;
const admin = process.env.AUTOMATED_FEE_ADMIN_ADDRESS || "";
const guardian = process.env.AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS || "";
const keeper = process.env.AUTOMATED_FEE_KEEPER_ADDRESS || "";
const quoteAuthorizer = process.env.AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS || "";
const universalRouter = process.env.PONS_V4_UNIVERSAL_ROUTER_ADDRESS || "";
const permit2 = process.env.PONS_PERMIT2_ADDRESS || "";
const v3Router = process.env.AUTOMATED_FEE_V3_ROUTER_ADDRESS || "0xcaf681a66d020601342297493863e78c959e5cb2";
const weth = process.env.AUTOMATED_FEE_WETH_ADDRESS || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

for (const [label, address] of Object.entries({ ponsFactory, universalRouter, permit2, v3Router, weth, admin, guardian, keeper, quoteAuthorizer })) {
  if (!isAddress(address, { strict: false })) throw new Error(`${label} is missing or invalid`);
}

const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");
const feeEscrow = await client.readContract({
  address: ponsFactory,
  abi: parseAbi(["function feeEscrow() view returns (address)"]),
  functionName: "feeEscrow",
});
const pinnedDependencies = { ponsFactory, feeEscrow, universalRouter, permit2, v3Router, weth, ponsbot: PONSBOT };
for (const [label, address] of Object.entries(pinnedDependencies)) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode`);
}
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
for (const [label, address] of Object.entries({ ponsFactory, universalRouter })) {
  const [implementationSlot, beaconSlot] = await Promise.all([
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT }),
  ]);
  const populated = (value) => value && BigInt(value) !== 0n;
  if (populated(implementationSlot) || populated(beaconSlot)) {
    throw new Error(`${label} is an upgradeable EIP-1967 dependency; deployment requires an implementation-aware pin`);
  }
}

async function artifact(name) {
  const [abiText, bytecodeText] = await Promise.all([
    readFile(new URL(`../contracts/build-check/${name}.abi`, import.meta.url), "utf8"),
    readFile(new URL(`../contracts/build-check/${name}.bin`, import.meta.url), "utf8"),
  ]);
  const abi = JSON.parse(abiText);
  const bytecode = `0x${bytecodeText.trim()}`;
  if (bytecode === "0x") throw new Error(`${name} bytecode is empty; run automated-fees:compile first`);
  return { abi, bytecode };
}

const [controlArtifact, vaultArtifact, factoryArtifact, adapterArtifact, nativeExecutorArtifact, pairedExecutorArtifact] = await Promise.all([
  artifact("PonsBotFeeControl"), artifact("PonsBotFeeVault"), artifact("PonsBotFeeVaultFactory"),
  artifact("PonsBotBuybackAdapter"), artifact("PonsBotNativeBuybackExecutor"), artifact("PonsBotPairedBuybackExecutor"),
]);
const pendingNonce = await client.getTransactionCount({ address: admin, blockTag: "pending" });
const predicted = Array.from({ length: 6 }, (_, offset) =>
  getContractAddress({ from: admin, nonce: BigInt(pendingNonce + offset) }));
const [controlAddress, vaultImplementationAddress, vaultFactoryAddress, adapterAddress, nativeExecutorAddress, pairedExecutorAddress] = predicted;
const definitions = [
  ["PonsBotFeeControl", controlArtifact, [admin, guardian, keeper, quoteAuthorizer]],
  ["PonsBotFeeVault", vaultArtifact, []],
  ["PonsBotFeeVaultFactory", factoryArtifact, [vaultImplementationAddress, controlAddress, ponsFactory, feeEscrow, PONSBOT]],
  ["PonsBotBuybackAdapter", adapterArtifact, [vaultFactoryAddress, controlAddress, PONSBOT]],
  ["PonsBotNativeBuybackExecutor", nativeExecutorArtifact, [adapterAddress, ponsFactory, universalRouter, PONSBOT]],
  ["PonsBotPairedBuybackExecutor", pairedExecutorArtifact, [
    adapterAddress, ponsFactory, universalRouter, permit2, v3Router, weth, controlAddress, PONSBOT,
  ]],
];
const steps = definitions.map(([contract, artifactValue, args], index) => {
  const data = encodeDeployData({ ...artifactValue, args });
  return {
    order: index + 1,
    contract,
    predictedAddress: predicted[index],
    constructorArgs: args,
    initCodeBytes: (data.length - 2) / 2,
    initCodeHash: keccak256(data),
  };
});

console.log(JSON.stringify({
  mode: "read_only_deployment_plan",
  mutationSent: false,
  chainId: CHAIN_ID,
  admin,
  pendingNonce,
  pinnedDependencies,
  warning: "Predicted addresses remain valid only while the admin pending nonce is unchanged.",
  postDeploymentActions: [
    `PonsBotFeeControl(${controlAddress}).setExecutionAdapter(${adapterAddress})`,
    `PonsBotBuybackAdapter(${adapterAddress}).setExecutor(${nativeExecutorAddress}, true)`,
    `PonsBotBuybackAdapter(${adapterAddress}).setExecutor(${pairedExecutorAddress}, true)`,
    `Configure every supported pair route on PonsBotPairedBuybackExecutor(${pairedExecutorAddress}) while processing is disabled.`,
    "Confirm processing remains disabled while configuring both bytecode-pinned executors.",
    "Keep processingEnabled=false until route verification, audit, and explicit production approval are complete.",
  ],
  steps,
}, null, 2));
