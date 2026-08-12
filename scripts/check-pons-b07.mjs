import fs from "node:fs";
import {
  createPublicClient, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  http, keccak256, parseAbi, parseEther,
} from "viem";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
  const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
}));
// Keep this diagnostic off the production provider; it is intentionally read-only and request-heavy.
const rpcUrl = process.env.PONS_CHECK_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ batch: { multicall: true }, transport: http(rpcUrl) });
const factory = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const router = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948";
const sourceTransaction = "0x57da1faf4175641232d8b4de594a1999f9f50da819266429752f4de1980f25a7";
const sourceToken = "0xb3ecf7a16de3d0ec9b538a31efd57375dd563db1";
const factoryAbi = parseAbi([
  "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function getLaunchConfig(uint256) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function previewLaunchEconomics(uint256,address) view returns(bytes32)",
  "function feeEscrow() view returns(address)", "function buybackVault() view returns(address)", "function launchDeployer() view returns(address)", "function memeHook() view returns(address)",
]);
const hookAbi = parseAbi(["function currentFeePolicy() view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))"]);
const routerAbi = parseAbi(["function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns(address token,address curve,uint256 tokensOut)"]);
const predictorAbi = parseAbi(["function predictLaunchAddresses((address pairToken,address creatorFeeRecipient,address originalDeployer,address feePolicy,(address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps) policy,address feeEscrow,address buybackVault,uint256 phantomQuote,uint256 curveFeeBps,uint256 creatorTaxBps,bool buybackEnabled,uint256 graduationThreshold,uint256 supply,bytes32 salt,string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials)) view returns(address token,address curve)"]);

const transaction = await client.getTransaction({ hash: sourceTransaction });
const decoded = decodeFunctionData({ abi: routerAbi, data: transaction.input });
const [metadata, launchConfigId, pairToken, quoteIn, , recipient, exemptions] = decoded.args;
const launch = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [sourceToken] });
const [feeEscrow, buybackVault, deployer, config, expectedEconomics, memeHook] = await Promise.all([
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "buybackVault" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchDeployer" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchConfig", args: [launchConfigId] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [launchConfigId, pairToken] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
]);
const policy = await client.readContract({ address: memeHook, abi: hookAbi, functionName: "currentFeePolicy" });
const base = {
  pairToken, creatorFeeRecipient: transaction.from, originalDeployer: transaction.from, feePolicy: memeHook, policy,
  feeEscrow, buybackVault, phantomQuote: config.phantomQuote, curveFeeBps: config.curveFeeBps, creatorTaxBps: 0n, buybackEnabled: false,
  graduationThreshold: config.graduationThreshold, supply: config.supply,
  name: "Pons Bot b07 simulation", symbol: "B07TEST", logo: "", description: "Read-only expected launch simulation",
  socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
};
const seed = keccak256(new TextEncoder().encode("pons-bot-b07-read-only-check"));
let selected;
for (let offset = 0; offset < 100_000 && !selected; offset += 24) {
  const candidates = Array.from({ length: 24 }, (_, index) => {
    const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(offset + index)]));
    return { salt, contract: { address: deployer, abi: predictorAbi, functionName: "predictLaunchAddresses", args: [{ ...base, salt }] } };
  });
  const results = await client.multicall({ contracts: candidates.map((candidate) => candidate.contract), allowFailure: true, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11" });
  for (let index = 0; index < results.length; index++) {
    if (results[index].status === "success" && results[index].result[0].toLowerCase().endsWith("b07")) selected = { salt: candidates[index].salt, token: results[index].result[0], curve: results[index].result[1], attempt: offset + index + 1 };
  }
}
if (!selected) throw new Error("No b07 candidate found within 100,000 attempts");
const launchParams = { ...metadata, ...base, expectedEconomics, salt: selected.salt };
const callData = encodeFunctionData({ abi: routerAbi, functionName: "launchAndBuy", args: [launchParams, launchConfigId, pairToken, quoteIn, 0n, recipient, exemptions] });
const response = await client.call({ account: transaction.from, to: router, data: callData, value: transaction.value, stateOverride: [{ address: transaction.from, balance: parseEther("10") }] });
const [expectedToken, expectedCurve, tokensOut] = decodeFunctionResult({ abi: routerAbi, functionName: "launchAndBuy", data: response.data });
if (expectedToken.toLowerCase() !== selected.token.toLowerCase() || expectedCurve.toLowerCase() !== selected.curve.toLowerCase()) {
  console.log(JSON.stringify({ selected, expectedToken, expectedCurve }, null, 2));
  throw new Error("Expected launch and predictor disagree");
}
console.log(JSON.stringify({ ...selected, expectedToken, expectedCurve, tokensOut: tokensOut.toString(), simulated: true, broadcast: false }, null, 2));
