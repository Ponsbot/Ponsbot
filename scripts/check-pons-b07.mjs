import {
  createPublicClient, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  http, keccak256, parseAbi, parseEther,
} from "viem";

// Keep this diagnostic off the production provider; it is intentionally read-only and request-heavy.
const rpcUrl = process.env.PONS_CHECK_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ batch: { multicall: true }, transport: http(rpcUrl) });
const factory = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const router = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948";
const sourceTransaction = "0x57da1faf4175641232d8b4de594a1999f9f50da819266429752f4de1980f25a7";
const factoryAbi = parseAbi([
  "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function getLaunchConfig(uint256) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function previewLaunchEconomics(uint256,address) view returns(bytes32)",
  "function launchFee() view returns(uint256)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns(address token,address curve)",
  "function feeEscrow() view returns(address)", "function buybackVault() view returns(address)", "function launchDeployer() view returns(address)", "function memeHook() view returns(address)",
]);
const hookAbi = parseAbi(["function currentFeePolicy() view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))"]);
const routerAbi = parseAbi(["function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns(address token,address curve,uint256 tokensOut)"]);
const predictorAbi = parseAbi(["function predictLaunchAddresses((address pairToken,address creatorFeeRecipient,address originalDeployer,address feePolicy,(address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps) policy,address feeEscrow,address buybackVault,uint256 phantomQuote,uint256 curveFeeBps,uint256 creatorTaxBps,bool buybackEnabled,uint256 graduationThreshold,uint256 supply,bytes32 salt,string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials)) view returns(address token,address curve)"]);

const transaction = await client.getTransaction({ hash: sourceTransaction });
const decoded = decodeFunctionData({ abi: routerAbi, data: transaction.input });
const [metadata, launchConfigId, pairToken, quoteIn, , recipient, exemptions] = decoded.args;
const [feeEscrow, buybackVault, deployer, config, expectedEconomics, memeHook] = await Promise.all([
  client.readContract({ address: factory, abi: factoryAbi, functionName: "feeEscrow" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "buybackVault" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchDeployer" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchConfig", args: [launchConfigId] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [launchConfigId, pairToken] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
]);
const policy = await client.readContract({ address: memeHook, abi: hookAbi, functionName: "currentFeePolicy" });
const launchFee = await client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" });
const scenarios = [
  { id: "launch-only-minimal", mode: "launch", name: "B07 Minimal", symbol: "B07MIN", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } },
  { id: "launch-buy-socials", mode: "buy", name: "Pons Bot Simulation", symbol: "B07SOC", logo: "https://pbs.twimg.com/media/HPdwdAEWsAAUoji?format=jpg&name=large", description: "Full metadata read-only launch simulation", socials: { twitter: "https://x.com/Ponsbotfamily", telegram: "https://t.me/test", discord: "", website: "https://ponsbot.family", farcaster: "" } },
  { id: "launch-buy-spaces", mode: "buy", name: "A World of Possibilities", symbol: "B07X3", logo: "", description: "Names, spaces, and deterministic retry check", socials: { twitter: "", telegram: "", discord: "", website: "https://ponsbot.family", farcaster: "" } },
];
const outputs = [];
for (const scenario of scenarios) {
  const base = {
    pairToken, creatorFeeRecipient: transaction.from, originalDeployer: transaction.from, feePolicy: memeHook, policy,
    feeEscrow, buybackVault, phantomQuote: config.phantomQuote, curveFeeBps: config.curveFeeBps, creatorTaxBps: 0n, buybackEnabled: false,
    graduationThreshold: config.graduationThreshold, supply: config.supply,
    name: scenario.name, symbol: scenario.symbol, logo: scenario.logo, description: scenario.description, socials: scenario.socials,
  };
  const seed = keccak256(new TextEncoder().encode(`pons-bot-b07-${scenario.id}`));
  let selected;
  for (let offset = 0; offset < 100_000 && !selected; offset += 24) {
    const candidates = Array.from({ length: 24 }, (_, index) => {
      const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(offset + index)]));
      return { salt, contract: { address: deployer, abi: predictorAbi, functionName: "predictLaunchAddresses", args: [{ ...base, salt }] } };
    });
    const results = await client.multicall({ contracts: candidates.map((candidate) => candidate.contract), allowFailure: true, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11" });
    for (let index = 0; index < results.length; index++) if (results[index].status === "success" && results[index].result[0].toLowerCase().endsWith("b07")) selected = { salt: candidates[index].salt, token: results[index].result[0], curve: results[index].result[1], attempt: offset + index + 1 };
  }
  if (!selected) throw new Error(`${scenario.id}: no b07 candidate found`);
  const persisted = await client.readContract({ address: deployer, abi: predictorAbi, functionName: "predictLaunchAddresses", args: [{ ...base, salt: selected.salt }] });
  if (persisted[0].toLowerCase() !== selected.token.toLowerCase() || persisted[1].toLowerCase() !== selected.curve.toLowerCase()) throw new Error(`${scenario.id}: persisted prediction changed`);
  const launchParams = { ...metadata, ...base, expectedEconomics, salt: selected.salt };
  let expectedToken; let expectedCurve; let tokensOut = 0n;
  if (scenario.mode === "buy") {
    const callData = encodeFunctionData({ abi: routerAbi, functionName: "launchAndBuy", args: [launchParams, launchConfigId, pairToken, quoteIn, 0n, recipient, exemptions] });
    const response = await client.call({ account: transaction.from, to: router, data: callData, value: transaction.value, stateOverride: [{ address: transaction.from, balance: parseEther("10") }] });
    [expectedToken, expectedCurve, tokensOut] = decodeFunctionResult({ abi: routerAbi, functionName: "launchAndBuy", data: response.data });
  } else {
    const callData = encodeFunctionData({ abi: factoryAbi, functionName: "launchToken", args: [launchParams, launchConfigId, pairToken, []] });
    const response = await client.call({ account: transaction.from, to: factory, data: callData, value: launchFee, stateOverride: [{ address: transaction.from, balance: parseEther("10") }] });
    [expectedToken, expectedCurve] = decodeFunctionResult({ abi: factoryAbi, functionName: "launchToken", data: response.data });
  }
  if (expectedToken.toLowerCase() !== selected.token.toLowerCase() || expectedCurve.toLowerCase() !== selected.curve.toLowerCase()) throw new Error(`${scenario.id}: expected launch and predictor disagree`);
  outputs.push({ scenario: scenario.id, mode: scenario.mode, ...selected, expectedToken, expectedCurve, tokensOut: tokensOut.toString(), persistedRetryMatched: true, simulated: true, broadcast: false });
}
console.log(JSON.stringify(outputs, null, 2));
