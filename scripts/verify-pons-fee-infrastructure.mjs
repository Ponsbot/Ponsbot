import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
} from "viem";

const CHAIN_ID = 4663;
const DEFAULT_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const DEFAULT_TOKEN = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";
const DEFAULT_HOLDER_FACTORY = "0x70e95CC5f03DB2906081E7a8D16e4C4209291507";
const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const factory = process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_FACTORY;
const token = process.env.AUTOMATED_FEE_ANALYSIS_TOKEN_ADDRESS || DEFAULT_TOKEN;
const holderFactory = process.env.PONS_HOLDER_DISTRIBUTOR_FACTORY_ADDRESS || DEFAULT_HOLDER_FACTORY;
for (const [name, address] of Object.entries({ factory, token, holderFactory })) {
  if (!isAddress(address, { strict: false })) throw new Error(`${name} address is invalid`);
}

const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function launchDeployer() view returns (address)",
  "function buybackVault() view returns (address)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function transferCreatorFeeRecipient(address token,address newRecipient)",
]);
const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient,address token) view returns (uint256)",
  "function claim()",
  "function claimToken(address token)",
]);
const curveAbi = parseAbi(["function sweepFees(uint256 minBuybackTokensOut)"]);
const holderFactoryAbi = parseAbi([
  "function distributorOf(address token) view returns (address)",
  "function createFor(address token) returns (address distributor)",
]);

const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");

async function contractEvidence(label, address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode at ${address}`);
  return { label, address, bytecodeBytes: (code.length - 2) / 2, bytecodeHash: keccak256(code) };
}
async function simulate(label, request) {
  try {
    await client.call(request);
    return { label, supported: true };
  } catch (error) {
    return { label, supported: false, reason: error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : "simulation failed" };
  }
}

const [launchFee, launchDeployer, buybackVault, memeHook, feeEscrow, launched, distributor] = await Promise.all([
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchDeployer" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "buybackVault" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }),
  client.readContract({ address: holderFactory, abi: holderFactoryAbi, functionName: "distributorOf", args: [token] }),
]);
if (!launched.exists || launched.token.toLowerCase() !== token.toLowerCase()) throw new Error("Analysis token is not a live Pons V2 launch");

const evidenceAddresses = {
  factory,
  token,
  curve: launched.curve,
  feeEscrow,
  launchDeployer,
  buybackVault,
  memeHook,
  holderFactory,
  ...(distributor !== zeroAddress ? { holderDistributor: distributor } : {}),
  ...(launched.pairToken !== zeroAddress ? { pairToken: launched.pairToken } : {}),
};
const bytecode = [];
for (const [label, address] of Object.entries(evidenceAddresses)) bytecode.push(await contractEvidence(label, address));

const [nativeClaimable, tokenClaimable] = await Promise.all([
  client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [launched.creatorFeeRecipient] }),
  launched.pairToken === zeroAddress
    ? Promise.resolve(0n)
    : client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOfToken", args: [launched.creatorFeeRecipient, launched.pairToken] }),
]);

const simulations = [];
simulations.push(await simulate("curve.sweepFees(0) from current creator recipient", {
  account: launched.creatorFeeRecipient,
  to: launched.curve,
  data: encodeFunctionData({ abi: curveAbi, functionName: "sweepFees", args: [0n] }),
}));
simulations.push(await simulate("factory.transferCreatorFeeRecipient to current recipient", {
  account: launched.creatorFeeRecipient,
  to: factory,
  data: encodeFunctionData({ abi: factoryAbi, functionName: "transferCreatorFeeRecipient", args: [token, launched.creatorFeeRecipient] }),
}));
if (launched.pairToken === zeroAddress) {
  simulations.push(await simulate("feeEscrow.claim from current creator recipient", {
    account: launched.creatorFeeRecipient,
    to: feeEscrow,
    data: encodeFunctionData({ abi: escrowAbi, functionName: "claim" }),
  }));
} else {
  simulations.push(await simulate("feeEscrow.claimToken from current creator recipient", {
    account: launched.creatorFeeRecipient,
    to: feeEscrow,
    data: encodeFunctionData({ abi: escrowAbi, functionName: "claimToken", args: [launched.pairToken] }),
  }));
}

console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(),
  chainId: CHAIN_ID,
  launchFeeWei: launchFee.toString(),
  launchFeeEth: formatEther(launchFee),
  token: {
    address: token,
    curve: launched.curve,
    deployer: launched.deployer,
    creatorFeeRecipient: launched.creatorFeeRecipient,
    pairToken: launched.pairToken,
    creatorTaxBps: Number(launched.creatorTaxBps),
    buybackEnabled: launched.buybackEnabled,
    phase: Number(launched.phase),
    sweptQuote: launched.sweptQuote.toString(),
    sweptTokens: launched.sweptTokens.toString(),
    sweptAt: launched.sweptAt.toString(),
    nativeClaimable: nativeClaimable.toString(),
    pairedTokenClaimable: tokenClaimable.toString(),
    holderDistributor: distributor === zeroAddress ? null : distributor,
  },
  infrastructure: { factory, launchDeployer, buybackVault, memeHook, feeEscrow, holderFactory },
  bytecode,
  simulations,
  mutationSent: false,
}, null, 2));

