import { createHmac, timingSafeEqual } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, encodePacked, formatEther, formatUnits, http, keccak256, parseAbi, parseAbiParameters, parseEther, parseSignature, parseTransaction, parseUnits, recoverTransactionAddress, serializeTransaction, zeroAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID, type BroadcastRequest, type ExecutionRequest, type TransactionStatusRequest } from "./policy";
import { checkedUsdToEthWei, ethUsdPrice } from "./pricing";

const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address recipient,uint256 amount) returns (bool)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function selfPermitIfNecessary(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s) payable",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const ponsFactoryAbi = parseAbi([
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
]);
const feeEscrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient,address token) view returns (uint256)",
  "function claim()",
  "function claimToken(address token)",
  "event Claimed(address indexed recipient,uint256 amount)",
  "event ClaimedToken(address indexed recipient,address indexed token,uint256 amount)",
]);
const ponsCurveAbi = parseAbi([
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut)",
]);
const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const universalRouterAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const permit2Abi = parseAbi(["function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)"]);
const ponsRouterAbi = parseAbi([
  "function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)",
  "event Launched(address indexed token,address indexed curve,address indexed recipient,address launcher,uint256 quoteSpent,uint256 tokensReceived)",
]);
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const V3_FEES = [100, 500, 3_000, 10_000] as const;
const ROUTE_CACHE_MS = 60_000;
const routeCache = new Map<string, { path: Hex; expiresAt: number }>();
let cdpClient: CdpClient | undefined;

function cdp() {
  cdpClient ||= new CdpClient({
    apiKeyId: required("CDP_API_KEY_ID"),
    apiKeySecret: required("CDP_API_KEY_SECRET"),
    walletSecret: required("CDP_WALLET_SECRET"),
  });
  return cdpClient;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function configuredAddress(name: string, supplied: string) {
  const configured = required(name);
  if (!/^0x[a-fA-F0-9]{40}$/.test(configured)) throw new Error(`${name} is not a valid address`);
  if (configured.toLowerCase() !== supplied.toLowerCase()) throw new Error(`${name} does not match the signer configuration`);
  return configured as Address;
}

function rpcClient() {
  return createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com") });
}

function accountName(ownerReference: string) {
  const digest = createHmac("sha256", required("WALLET_SIGNER_IDEMPOTENCY_SECRET"))
    .update(`ponsbot:robinhood:4663:${ownerReference}`).digest("hex");
  return `ponsbot-rh-${digest.slice(0, 25)}`;
}

export function authorizeSigner(header: string | null) {
  const expected = process.env.WALLET_SIGNER_TOKEN;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function provisionWallet(ownerReference: string): Promise<{ walletRef: string; address: string }> {
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(ownerReference) });
  return { walletRef: account.address, address: account.address };
}

export async function walletBalance(address: `0x${string}`, token?: string, knownTokens: Address[] = []): Promise<{ display: string; raw?: string; decimals?: number }> {
  const client = rpcClient();
  if (!token || /^eth$/i.test(token)) {
    const eth = formatEther(await client.getBalance({ address }));
    if (token) return { display: `${trimDecimal(eth)} ETH` };
    const holdings = [`${trimDecimal(eth)} ETH`];
    const tokenHoldings = await Promise.all([...new Set(knownTokens.map((value) => value.toLowerCase()))].map(async (tokenAddress) => {
      try {
        const [balance, decimals, symbol] = await Promise.all([
          client.readContract({ address: tokenAddress as Address, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
          client.readContract({ address: tokenAddress as Address, abi: tokenAbi, functionName: "decimals" }),
          client.readContract({ address: tokenAddress as Address, abi: tokenAbi, functionName: "symbol" }),
        ]);
        return balance > 0n ? `${trimDecimal(formatUnits(balance, decimals))} ${symbol}` : undefined;
      } catch { return undefined; }
    }));
    holdings.push(...tokenHoldings.filter((value): value is string => Boolean(value)));
    return { display: holdings.join("\n") };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) throw new Error("token lookup was not resolved by the registry");
  const tokenAddress = token as Address;
  const [balance, decimals, symbol] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "symbol" }),
  ]);
  return { display: `${trimDecimal(formatUnits(balance, decimals))} ${symbol}`, raw: balance.toString(), decimals };
}

function trimDecimal(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 8).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

async function resolveToken(identifier: string) {
  const normalized = identifier.replace(/^\$/, "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) throw new Error("token lookup was not resolved by the registry");
  const client = rpcClient();
  const address = normalized as Address;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: tokenAbi, functionName: "symbol" }),
    client.readContract({ address, abi: tokenAbi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals };
}

async function resolveActivePonsCurve(token: Address, factory: Address) {
  const launched = await rpcClient().readContract({
    address: factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token],
  });
  if (!launched.exists) return undefined;
  return launched;
}

export async function ponsPairInfo(token: Address, factory: Address) {
  const launched = await resolveActivePonsCurve(token, factory);
  if (!launched) return { isPons: false as const };
  return {
    isPons: true as const,
    pairToken: launched.pairToken,
    nativePair: launched.pairToken === zeroAddress,
    phase: launched.phase,
  };
}

type V4PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

function encodeV4ExactInput(poolKey: V4PoolKey, zeroForOne: boolean, amountIn: bigint, minimum: bigint) {
  const swap = encodeAbiParameters(
    parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)"),
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: minimum, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const output = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const input = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const takeAll = encodeAbiParameters(parseAbiParameters("address currency,uint256 minAmount"), [output, minimum]);
  const settleAll = encodeAbiParameters(parseAbiParameters("address currency,uint256 maxAmount"), [input, amountIn]);
  return encodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), ["0x060f0c", [swap, takeAll, settleAll]]);
}

async function prepareGraduatedPonsV4Buy(request: ExecutionRequest, owner: Address, token: Address, launched: {
  pairToken: Address; poolFee: number; tickSpacing: number;
}, amountIn: bigint, slippageBps: number, factory: Address, infrastructure: {
  quoter: Address; router: Address; permit2: Address;
}) {
  const client = rpcClient();
  const pair = launched.pairToken;
  const hook = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" });
  const tokenIsCurrency0 = BigInt(token) < BigInt(pair);
  const currency0 = tokenIsCurrency0 ? token : pair;
  const currency1 = tokenIsCurrency0 ? pair : token;
  const poolKey = { currency0, currency1, fee: launched.poolFee, tickSpacing: launched.tickSpacing, hooks: hook };
  const zeroForOne = !tokenIsCurrency0;
  const quote = await client.simulateContract({
    address: infrastructure.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  const minimum = quote.result[0] * BigInt(10_000 - slippageBps) / 10_000n;
  const v4Input = encodeV4ExactInput(poolKey, zeroForOne, amountIn, minimum);
  const now = Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 10 * 60);
  if (pair === zeroAddress) {
    const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x10", [v4Input], deadline] });
    return { ...(await prepareSigned(request, infrastructure.router, data, amountIn)), ...(await tradeOutputSnapshot(owner, token)), involvedPairTokenAddress: pair };
  }
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: pair, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: pair, abi: tokenAbi, functionName: "allowance", args: [owner, infrastructure.permit2] }),
  ]);
  if (balance < amountIn) throw new Error("insufficient paired asset balance; first you need to buy the paired asset");
  if (allowance < amountIn) return prepareApproval(request, pair, infrastructure.permit2, amountIn, "pair-permit2-approval");
  const [, , nonce] = await client.readContract({ address: infrastructure.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, pair, infrastructure.router] });
  const permit = { details: { token: pair, amount: amountIn, expiration: now + 30 * 24 * 60 * 60, nonce }, spender: infrastructure.router, sigDeadline: deadline };
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  const signature = await account.signTypedData({
    domain: { name: "Permit2", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: infrastructure.permit2 },
    types: {
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
    },
    primaryType: "PermitSingle", message: permit,
  });
  const permitInput = encodeAbiParameters(
    parseAbiParameters("((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permit,bytes signature"),
    [permit, signature],
  );
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x0a10", [permitInput, v4Input], deadline] });
  return { ...(await prepareSigned(request, infrastructure.router, data, 0n)), ...(await tradeOutputSnapshot(owner, token)), involvedPairTokenAddress: pair };
}

async function bestV3Route(tokenIn: Address, tokenOut: Address, quoter: Address, amountIn: bigint) {
  const candidates: Hex[] = [];
  for (const fee of V3_FEES) candidates.push(encodePacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]));
  if (tokenIn.toLowerCase() !== USDG && tokenOut.toLowerCase() !== USDG) {
    for (const firstFee of V3_FEES) for (const secondFee of V3_FEES) {
      candidates.push(encodePacked(
        ["address", "uint24", "address", "uint24", "address"],
        [tokenIn, firstFee, USDG, secondFee, tokenOut],
      ));
    }
  }
  const cacheKey = `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) candidates.unshift(cached.path);
  const uniqueCandidates = [...new Set(candidates)];
  const quoted: Array<{ path: Hex; amountOut: bigint } | undefined> = [];
  for (let offset = 0; offset < uniqueCandidates.length; offset += 5) {
    quoted.push(...await Promise.all(uniqueCandidates.slice(offset, offset + 5).map(async (path) => {
      try {
        const result = await rpcClient().simulateContract({
          address: quoter, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn],
        });
        return result.result[0] > 0n ? { path, amountOut: result.result[0] } : undefined;
      } catch { return undefined; }
    })));
  }
  const best = quoted.filter((item): item is { path: Hex; amountOut: bigint } => Boolean(item))
    .reduce<{ path: Hex; amountOut: bigint } | undefined>((current, item) => !current || item.amountOut > current.amountOut ? item : current, undefined);
  if (!best) throw new Error("quote returned no output");
  routeCache.set(cacheKey, { path: best.path, expiresAt: Date.now() + ROUTE_CACHE_MS });
  return best;
}

async function tokenAmount(address: Address, owner: Address, amount: string, unit: string, swap?: {
  weth: Address; quoter: Address; fee: number;
}) {
  const client = rpcClient();
  const decimals = await client.readContract({ address, abi: tokenAbi, functionName: "decimals" });
  if (unit === "token") return parseUnits(amount, decimals);
  if (unit === "percent") {
    const balance = await client.readContract({ address, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    return balance * BigInt(Math.round(Number(amount) * 100)) / 10_000n;
  }
  if (unit === "usd" && swap) return (await bestV3Route(swap.weth, address, swap.quoter, await checkedUsdToEthWei(amount))).amountOut;
  throw new Error("unsupported token amount unit");
}

async function enforceEthLimit(valueWei: bigint) {
  const maximum = Number(process.env.WALLET_MAX_TRANSACTION_USD || "10000");
  const usd = Number(formatEther(valueWei)) * await ethUsdPrice();
  if (!Number.isFinite(maximum) || maximum <= 0 || usd > maximum) throw new Error(`transaction exceeds the $${maximum} limit`);
}

async function ethTransferValue(owner: Address, recipient: Address, amount: string, unit: "eth" | "usd" | "percent") {
  const client = rpcClient();
  const requested = unit === "usd" ? await checkedUsdToEthWei(amount)
    : unit === "eth" ? parseEther(amount)
      : await client.getBalance({ address: owner }) * BigInt(Math.round(Number(amount) * 100)) / 10_000n;
  if (unit !== "percent") await enforceEthLimit(requested);
  const [balance, fees] = await Promise.all([client.getBalance({ address: owner }), client.estimateFeesPerGas()]);
  const gas = await client.estimateGas({ account: owner, to: recipient, value: requested > 0n ? requested : 1n }).catch(() => 21_000n);
  const gasReserve = gas * fees.maxFeePerGas * 125n / 100n;
  if (balance <= gasReserve) throw new Error("insufficient ETH for gas");
  const maximumTransfer = balance - gasReserve;
  if (unit !== "percent" && requested > maximumTransfer) throw new Error("ETH transfer amount plus gas exceeds wallet balance");
  const value = unit === "percent" && requested > maximumTransfer ? maximumTransfer : requested;
  if (value <= 0n) throw new Error("ETH transfer amount resolves to zero after reserving gas");
  return value;
}

async function prepareSigned(request: ExecutionRequest, to: Address, data: Hex, value: bigint) {
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  if (account.address.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("wallet owner mismatch");
  await client.call({ account: account.address, to, data, value });
  const [estimatedGas, fees, nonce] = await Promise.all([
    client.estimateGas({ account: account.address, to, data, value }),
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
  ]);
  const transaction = {
    chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to, data, value, nonce,
    gas: estimatedGas * 120n / 100n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const { signature } = await cdp().evm.signTransaction({
    address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey,
  });
  return {
    transactionHash: keccak256(signature), status: "prepared" as const, toAddress: to,
    signedTransaction: signature, valueWei: value.toString(),
  };
}

async function prepareApproval(request: ExecutionRequest, token: Address, spender: Address, amount: bigint, suffix: string) {
  const data = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, amount] });
  return {
    ...(await prepareSigned({ ...request, idempotencyKey: `${request.idempotencyKey}:${suffix}` }, token, data, 0n)),
    approvalRequired: true as const,
    approvalTokenAddress: token,
  };
}

async function tradeOutputSnapshot(owner: Address, outputToken: Address) {
  const balance = outputToken === zeroAddress
    ? await rpcClient().getBalance({ address: owner })
    : await rpcClient().readContract({ address: outputToken, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
  return { tradeOutputTokenAddress: outputToken, tradeOutputBalanceBefore: balance.toString() };
}

async function prepareGraduatedPonsV4Sell(request: ExecutionRequest, owner: Address, token: Address, launched: {
  pairToken: Address; poolFee: number; tickSpacing: number;
}, amount: bigint, slippageBps: number, factory: Address, infrastructure: {
  quoter: Address; router: Address; permit2: Address;
}) {
  const client = rpcClient();
  const tokenAllowance = await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [owner, infrastructure.permit2] });
  if (tokenAllowance < amount) {
    return prepareApproval(request, token, infrastructure.permit2, amount, "permit2-approval");
  }
  const hook = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" });
  const pair = launched.pairToken;
  const tokenIsCurrency0 = BigInt(token) < BigInt(pair);
  const poolKey = {
    currency0: tokenIsCurrency0 ? token : pair,
    currency1: tokenIsCurrency0 ? pair : token,
    fee: launched.poolFee, tickSpacing: launched.tickSpacing, hooks: hook,
  };
  const zeroForOne = tokenIsCurrency0;
  const quote = await client.simulateContract({
    address: infrastructure.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne, exactAmount: amount, hookData: "0x" }],
  });
  const minimum = quote.result[0] * BigInt(10_000 - slippageBps) / 10_000n;
  const [, , nonce] = await client.readContract({ address: infrastructure.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, infrastructure.router] });
  const now = Math.floor(Date.now() / 1000);
  const permit = {
    details: { token, amount, expiration: now + 30 * 24 * 60 * 60, nonce },
    spender: infrastructure.router, sigDeadline: BigInt(now + 10 * 60),
  };
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  const signature = await account.signTypedData({
    domain: { name: "Permit2", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: infrastructure.permit2 },
    types: {
      PermitDetails: [
        { name: "token", type: "address" }, { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" },
      ],
      PermitSingle: [
        { name: "details", type: "PermitDetails" }, { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "PermitSingle",
    message: permit,
  });
  const permitInput = encodeAbiParameters(
    parseAbiParameters("((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permit,bytes signature"),
    [permit, signature],
  );
  const v4Input = encodeV4ExactInput(poolKey, zeroForOne, amount, minimum);
  const deadline = BigInt(now + 10 * 60);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x0a10", [permitInput, v4Input], deadline] });
  return { ...(await prepareSigned(request, infrastructure.router, data, 0n)), ...(await tradeOutputSnapshot(owner, pair)), involvedPairTokenAddress: pair };
}

function launchSalt(request: ExecutionRequest) {
  return `0x${createHmac("sha256", required("WALLET_SIGNER_IDEMPOTENCY_SECRET"))
    .update(`pons-launch:${request.idempotencyKey}`).digest("hex")}` as Hex;
}

async function preparePonsLaunch(request: ExecutionRequest, operation: Extract<ExecutionRequest["operation"], {
  type: "pons_v2_launch" | "pons_v2_launch_and_buy";
}>) {
  const client = rpcClient();
  const factory = operation.factoryAddress as Address;
  const router = operation.launchAndBuyRouter as Address;
  const pairToken = operation.pairToken as Address;
  const launchConfigId = BigInt(operation.launchConfigId);
  const owner = request.expectedFrom as Address;
  const [expectedEconomics, launchFee] = await Promise.all([
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "previewLaunchEconomics", args: [launchConfigId, pairToken] }),
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "launchFee" }),
  ]);
  const params = {
    name: operation.name, symbol: operation.symbol, logo: operation.imageUri, description: operation.description,
    socials: { twitter: operation.socials.twitter, telegram: operation.socials.telegram, discord: "", website: operation.socials.website, farcaster: "" },
    creatorFeeRecipient: owner, creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics, salt: launchSalt(request),
  } as const;
  if (operation.type === "pons_v2_launch") {
    const simulation = await client.simulateContract({
      account: owner, address: factory, abi: ponsFactoryAbi, functionName: "launchToken",
      args: [params, launchConfigId, pairToken, []], value: launchFee,
    });
    const data = encodeFunctionData({ abi: ponsFactoryAbi, functionName: "launchToken", args: [params, launchConfigId, pairToken, []] });
    const prepared = await prepareSigned(request, factory, data, launchFee);
    return { ...prepared, tokenAddress: simulation.result[0], poolAddress: simulation.result[1], devBuySucceeded: false };
  }
  if (!operation.devBuy) throw new Error("initial launch buy amount is missing");
  const nativePair = pairToken === zeroAddress;
  let quoteIn: bigint;
  if (nativePair) {
    if (operation.devBuy.unit === "pair") throw new Error("an ETH-paired developer buy must use ETH or USD");
    quoteIn = operation.devBuy.unit === "usd" ? await checkedUsdToEthWei(operation.devBuy.amount) : parseEther(operation.devBuy.amount);
    await enforceEthLimit(quoteIn);
  } else {
    if (operation.devBuy.unit === "eth") throw new Error("a non-ETH developer buy must use USD or an amount of the paired asset");
    const [decimals, allowance] = await Promise.all([
      client.readContract({ address: pairToken, abi: tokenAbi, functionName: "decimals" }),
      client.readContract({ address: pairToken, abi: tokenAbi, functionName: "allowance", args: [owner, router] }),
    ]);
    quoteIn = operation.devBuy.unit === "usd"
      ? (await bestV3Route(operation.wethAddress as Address, pairToken, operation.quoterAddress as Address, await checkedUsdToEthWei(operation.devBuy.amount))).amountOut
      : parseUnits(operation.devBuy.amount, decimals);
    if (allowance < quoteIn) {
      return prepareApproval(request, pairToken, router, quoteIn, "pair-approval");
    }
  }
  const value = launchFee + (nativePair ? quoteIn : 0n);
  const first = await client.simulateContract({
    account: owner, address: router, abi: ponsRouterAbi, functionName: "launchAndBuy",
    args: [params, launchConfigId, pairToken, quoteIn, 0n, owner, []], value,
  });
  const minimum = first.result[2] * 9_750n / 10_000n;
  const data = encodeFunctionData({
    abi: ponsRouterAbi, functionName: "launchAndBuy",
    args: [params, launchConfigId, pairToken, quoteIn, minimum, owner, []],
  });
  const prepared = await prepareSigned(request, router, data, value);
  return { ...prepared, tokenAddress: first.result[0], poolAddress: first.result[1], devBuySucceeded: true };
}

export async function executeTransaction(request: ExecutionRequest) {
  const operation = request.operation;
  const owner = request.expectedFrom as Address;
  if (operation.type === "erc20_burn_to_dead" && operation.deadAddress.toLowerCase() !== DEAD.toLowerCase()) {
    throw new Error("burn destination policy rejected the request");
  }
  if (operation.type === "eth_transfer") {
    const value = await ethTransferValue(owner, operation.recipient as Address, operation.amount, operation.unit);
    return prepareSigned(request, operation.recipient as Address, "0x", value);
  }
  if (operation.type === "erc20_transfer" || operation.type === "erc20_burn_to_dead") {
    const resolved = await resolveToken(operation.token);
    const recipient = operation.type === "erc20_transfer" ? operation.recipient : operation.deadAddress;
    const amount = await tokenAmount(resolved.address, owner, operation.amount, operation.unit, {
      weth: operation.wethAddress as Address, quoter: operation.quoterAddress as Address,
      fee: operation.fee,
    });
    if (amount <= 0n) throw new Error("token amount resolved to zero");
    const balance = await rpcClient().readContract({ address: resolved.address, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    if (amount > balance) throw new Error("insufficient token balance");
    const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [recipient as Address, amount] });
    return prepareSigned(request, resolved.address, data, 0n);
  }
  if (operation.type === "uniswap_v3_buy") {
    const resolved = await resolveToken(operation.token);
    const pons = await resolveActivePonsCurve(resolved.address, operation.ponsFactoryAddress as Address);
    if (pons) {
      const nativePair = pons.pairToken === zeroAddress;
      if (nativePair && operation.unit === "pair") throw new Error("this Pons V2 token is paired with ETH; specify an ETH or dollar amount");
      if (!nativePair && operation.unit === "eth") throw new Error("this Pons V2 token buys with its paired asset; specify a dollar amount or an amount of the paired asset");
      if (operation.unit === "pair" && operation.pairAsset?.toLowerCase() !== pons.pairToken.toLowerCase()) {
        throw new Error("the named paired asset does not match this Pons V2 token's actual pair");
      }
      const ethValue = operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount)
        : operation.unit === "eth" ? parseEther(operation.amount) : 0n;
      if (operation.unit === "usd" || operation.unit === "eth") await enforceEthLimit(ethValue);
      const quoteIn = nativePair ? ethValue : operation.unit === "usd"
        ? (await bestV3Route(operation.wethAddress as Address, pons.pairToken, operation.quoterAddress as Address, ethValue)).amountOut
        : parseUnits(operation.amount, await rpcClient().readContract({ address: pons.pairToken, abi: tokenAbi, functionName: "decimals" }));
      if (pons.phase === 2) return prepareGraduatedPonsV4Buy(request, owner, resolved.address, pons, quoteIn, operation.slippageBps, operation.ponsFactoryAddress as Address, {
        quoter: configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress),
        router: configuredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS", operation.universalRouterAddress),
        permit2: configuredAddress("PONS_PERMIT2_ADDRESS", operation.permit2Address),
      });
      if (pons.phase !== 0) throw new Error("this Pons V2 token is still finalizing its Uniswap V4 pool");
      if (!nativePair) {
        const [balance, allowance] = await Promise.all([
          rpcClient().readContract({ address: pons.pairToken, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
          rpcClient().readContract({ address: pons.pairToken, abi: tokenAbi, functionName: "allowance", args: [owner, pons.curve] }),
        ]);
        if (balance < quoteIn) throw new Error("insufficient paired asset balance; first you need to buy the paired asset");
        if (allowance < quoteIn) return prepareApproval(request, pons.pairToken, pons.curve, quoteIn, "curve-pair-approval");
      }
      const simulation = await rpcClient().simulateContract({
        account: owner, address: pons.curve, abi: ponsCurveAbi, functionName: "buy", args: [quoteIn, 0n, owner], value: nativePair ? quoteIn : 0n,
      });
      const minimum = simulation.result * BigInt(10_000 - operation.slippageBps) / 10_000n;
      const data = encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [quoteIn, minimum, owner] });
      return { ...(await prepareSigned(request, pons.curve, data, nativePair ? quoteIn : 0n)), ...(await tradeOutputSnapshot(owner, resolved.address)), involvedPairTokenAddress: pons.pairToken };
    }
    if (operation.unit === "pair") throw new Error("paired-asset amounts are only supported for Pons V2 tokens");
    const value = operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount) : parseEther(operation.amount);
    await enforceEthLimit(value);
    const quote = await bestV3Route(operation.wethAddress as Address, resolved.address, operation.quoterAddress as Address, value);
    const minimum = quote.amountOut * BigInt(10_000 - operation.slippageBps) / 10_000n;
    const data = encodeFunctionData({
      abi: routerAbi, functionName: "exactInput",
      args: [{ path: quote.path, recipient: owner, amountIn: value, amountOutMinimum: minimum }],
    });
    return { ...(await prepareSigned(request, operation.routerAddress as Address, data, value)), ...(await tradeOutputSnapshot(owner, resolved.address)) };
  }
  if (operation.type === "uniswap_v3_sell") {
    const resolved = await resolveToken(operation.token);
    const amount = await tokenAmount(resolved.address, owner, operation.amount, operation.unit);
    const client = rpcClient();
    const pons = await resolveActivePonsCurve(resolved.address, operation.ponsFactoryAddress as Address);
    if (pons) {
      if (pons.phase === 2) return prepareGraduatedPonsV4Sell(request, owner, resolved.address, pons, amount, operation.slippageBps, operation.ponsFactoryAddress as Address, {
        quoter: configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress),
        router: configuredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS", operation.universalRouterAddress),
        permit2: configuredAddress("PONS_PERMIT2_ADDRESS", operation.permit2Address),
      });
      if (pons.phase !== 0) throw new Error("this Pons V2 token is still finalizing its Uniswap V4 pool");
      const allowance = await client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "allowance", args: [owner, pons.curve] });
      if (allowance < amount) {
        return prepareApproval(request, resolved.address, pons.curve, amount, "curve-approval");
      }
      const simulation = await client.simulateContract({
        account: owner, address: pons.curve, abi: ponsCurveAbi, functionName: "sell", args: [amount, 0n, owner],
      });
      const minimum = simulation.result * BigInt(10_000 - operation.slippageBps) / 10_000n;
      const data = encodeFunctionData({ abi: ponsCurveAbi, functionName: "sell", args: [amount, minimum, owner] });
      return { ...(await prepareSigned(request, pons.curve, data, 0n)), ...(await tradeOutputSnapshot(owner, pons.pairToken)), involvedPairTokenAddress: pons.pairToken };
    }
    const allowance = await client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "allowance", args: [owner, operation.routerAddress as Address] });
    const quote = await bestV3Route(resolved.address, operation.wethAddress as Address, operation.quoterAddress as Address, amount);
    const minimum = quote.amountOut * BigInt(10_000 - operation.slippageBps) / 10_000n;
    const swapData = encodeFunctionData({
      abi: routerAbi, functionName: "exactInput",
      args: [{ path: quote.path, recipient: "0x0000000000000000000000000000000000000002", amountIn: amount, amountOutMinimum: minimum }],
    });
    const unwrapData = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minimum, owner] });
    let calls: Hex[] = [swapData, unwrapData];
    if (allowance < amount) {
      const [name, nonce] = await Promise.all([
        client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "name" }),
        client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "nonces", args: [owner] }),
      ]);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
      const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
      const signature = await account.signTypedData({
        domain: { name, version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: resolved.address },
        types: { Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" },
          { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
        ] },
        primaryType: "Permit",
        message: { owner, spender: operation.routerAddress as Address, value: amount, nonce, deadline },
      });
      const parsed = parseSignature(signature);
      if (parsed.v === undefined) throw new Error("permit signature recovery id is missing");
      const permitData = encodeFunctionData({
        abi: routerAbi, functionName: "selfPermitIfNecessary",
        args: [resolved.address, amount, deadline, Number(parsed.v), parsed.r, parsed.s],
      });
      calls = [permitData, ...calls];
    }
    const data = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [calls] });
    return { ...(await prepareSigned(request, operation.routerAddress as Address, data, 0n)), ...(await tradeOutputSnapshot(owner, zeroAddress)) };
  }
  if (operation.type === "pons_v2_launch" || operation.type === "pons_v2_launch_and_buy") {
    return preparePonsLaunch(request, operation);
  }
  if (operation.type === "pons_v2_claim_fees") {
    const client = rpcClient();
    const factory = operation.factoryAddress as Address;
    const escrow = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "feeEscrow" });
    let pairToken: Address = zeroAddress;
    if (operation.token) {
      const resolved = await resolveToken(operation.token);
      const launched = await resolveActivePonsCurve(resolved.address, factory);
      if (!launched) throw new Error("no completed Pons launch was found for that token");
      if (launched.creatorFeeRecipient.toLowerCase() !== owner.toLowerCase()) throw new Error("wallet is not the launch creator fee beneficiary");
      pairToken = launched.pairToken;
    }
    if (pairToken === zeroAddress) {
      const balance = await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [owner] });
      if (balance === 0n) throw new Error("no claimable creator fees are available in ETH");
      const data = encodeFunctionData({ abi: feeEscrowAbi, functionName: "claim" });
      return prepareSigned(request, escrow, data, 0n);
    }
    const balance = await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOfToken", args: [owner, pairToken] });
    if (balance === 0n) throw new Error("no claimable creator fees are available in the paired asset");
    const data = encodeFunctionData({ abi: feeEscrowAbi, functionName: "claimToken", args: [pairToken] });
    return prepareSigned(request, escrow, data, 0n);
  }
  throw new Error("unsupported signer operation");
}

export async function broadcastTransaction(request: BroadcastRequest) {
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({
    serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"],
  });
  if (sender.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("signed transaction sender mismatch");
  if (parsed.chainId !== ROBINHOOD_CHAIN_ID) throw new Error("signed transaction chain mismatch");
  if (!parsed.to || parsed.to.toLowerCase() !== request.expectedTo.toLowerCase()) throw new Error("signed transaction destination mismatch");
  if ((parsed.value || 0n).toString() !== request.expectedValueWei) throw new Error("signed transaction value mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("signed transaction hash mismatch");
  const transactionHash = await rpcClient().sendRawTransaction({ serializedTransaction: signed });
  if (transactionHash.toLowerCase() !== localHash.toLowerCase()) throw new Error("RPC returned a mismatched transaction hash");
  return { transactionHash, status: "broadcast" as const, valueWei: request.expectedValueWei };
}

export async function transactionStatus(request: TransactionStatusRequest) {
  const client = rpcClient();
  let transaction;
  try {
    transaction = await client.getTransaction({ hash: request.transactionHash as Hex });
  } catch {
    return { transactionHash: request.transactionHash, status: "pending" as const, valueWei: request.expectedValueWei };
  }
  if (transaction.from.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("on-chain transaction sender mismatch");
  if (!transaction.to || transaction.to.toLowerCase() !== request.expectedTo.toLowerCase()) throw new Error("on-chain transaction destination mismatch");
  if (transaction.value.toString() !== request.expectedValueWei) throw new Error("on-chain transaction value mismatch");
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: request.transactionHash as Hex });
  } catch {
    return { transactionHash: request.transactionHash, status: "pending" as const, valueWei: request.expectedValueWei };
  }
  const result: {
      transactionHash: string; status: "confirmed" | "reverted"; blockNumber: string; valueWei: string;
      tokenAddress?: string; poolAddress?: string; devBuySucceeded?: boolean; claimedDisplay?: string;
      tradeOutputDisplay?: string; tradeOutputTokenAddress?: string; involvedPairTokenAddress?: string;
  } = {
      transactionHash: request.transactionHash,
      status: receipt.status === "success" ? "confirmed" as const : "reverted" as const,
      blockNumber: receipt.blockNumber.toString(), valueWei: request.expectedValueWei,
    };
  if (receipt.status === "success" && request.operationType.startsWith("pons_v2_launch")) {
      const factory = (request.expectedFactory || (request.operationType === "pons_v2_launch" ? request.expectedTo : "")).toLowerCase();
      if (!factory) throw new Error("expected Pons factory is missing from receipt verification");
      let verifiedOpeningBuy = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === factory) {
          try {
            const decoded = decodeEventLog({ abi: ponsFactoryAbi, data: log.data, topics: log.topics });
            if (decoded.eventName !== "TokenLaunched") continue;
            if (decoded.args.deployer.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("launch deployer mismatch");
            result.tokenAddress = decoded.args.token;
            result.poolAddress = decoded.args.curve;
          } catch (error) {
            if (error instanceof Error && error.message === "launch deployer mismatch") throw error;
          }
        }
        if (request.operationType === "pons_v2_launch_and_buy" && log.address.toLowerCase() === request.expectedTo.toLowerCase()) {
          try {
            const decoded = decodeEventLog({ abi: ponsRouterAbi, data: log.data, topics: log.topics });
            if (decoded.eventName !== "Launched") continue;
            if (decoded.args.launcher.toLowerCase() !== request.expectedFrom.toLowerCase()
              || decoded.args.recipient.toLowerCase() !== request.expectedFrom.toLowerCase()
              || decoded.args.quoteSpent <= 0n || decoded.args.tokensReceived <= 0n) {
              throw new Error("opening developer buy event mismatch");
            }
            if (result.tokenAddress && (decoded.args.token.toLowerCase() !== result.tokenAddress.toLowerCase()
              || decoded.args.curve.toLowerCase() !== result.poolAddress?.toLowerCase())) throw new Error("opening developer buy launch mismatch");
            verifiedOpeningBuy = true;
          } catch (error) {
            if (error instanceof Error && /opening developer buy/.test(error.message)) throw error;
          }
        }
      }
      if (!result.tokenAddress || !result.poolAddress) throw new Error("verified Pons launch event was not found");
      if (request.operationType === "pons_v2_launch_and_buy" && !verifiedOpeningBuy) throw new Error("verified opening developer buy event was not found");
      result.devBuySucceeded = request.operationType === "pons_v2_launch_and_buy" ? verifiedOpeningBuy : false;
  }
  if (receipt.status === "success" && request.operationType === "pons_v2_claim_fees") {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== request.expectedTo.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: feeEscrowAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "Claimed") {
          if (decoded.args.recipient.toLowerCase() !== request.expectedFrom.toLowerCase() || decoded.args.amount <= 0n) throw new Error("creator fee claim event mismatch");
          result.claimedDisplay = `${trimDecimal(formatEther(decoded.args.amount))} ETH`;
        }
        if (decoded.eventName === "ClaimedToken") {
          if (decoded.args.recipient.toLowerCase() !== request.expectedFrom.toLowerCase() || decoded.args.amount <= 0n) throw new Error("creator fee claim event mismatch");
          const [decimals, symbol] = await Promise.all([
            client.readContract({ address: decoded.args.token, abi: tokenAbi, functionName: "decimals" }),
            client.readContract({ address: decoded.args.token, abi: tokenAbi, functionName: "symbol" }),
          ]);
          result.claimedDisplay = `${trimDecimal(formatUnits(decoded.args.amount, decimals))} ${symbol}`;
        }
      } catch (error) {
        if (error instanceof Error && /creator fee claim event mismatch/.test(error.message)) throw error;
      }
    }
    if (!result.claimedDisplay) throw new Error("verified creator fee claim event was not found");
  }
  if (receipt.status === "success" && request.tradeOutputTokenAddress && request.tradeOutputBalanceBefore) {
    const outputToken = request.tradeOutputTokenAddress as Address;
    const before = BigInt(request.tradeOutputBalanceBefore);
    let after: bigint;
    let adjustment = 0n;
    let symbol: string;
    let decimals: number;
    if (outputToken === zeroAddress) {
      after = await client.getBalance({ address: request.expectedFrom as Address, blockNumber: receipt.blockNumber });
      adjustment = receipt.gasUsed * receipt.effectiveGasPrice;
      symbol = "ETH";
      decimals = 18;
    } else {
      [after, decimals, symbol] = await Promise.all([
        client.readContract({ address: outputToken, abi: tokenAbi, functionName: "balanceOf", args: [request.expectedFrom as Address], blockNumber: receipt.blockNumber }),
        client.readContract({ address: outputToken, abi: tokenAbi, functionName: "decimals" }),
        client.readContract({ address: outputToken, abi: tokenAbi, functionName: "symbol" }),
      ]);
    }
    const received = after + adjustment - before;
    if (received <= 0n) throw new Error("confirmed trade output could not be verified");
    result.tradeOutputDisplay = `${trimDecimal(formatUnits(received, decimals))} ${symbol}`;
    result.tradeOutputTokenAddress = outputToken;
    result.involvedPairTokenAddress = request.involvedPairTokenAddress;
  }
  return result;
}
