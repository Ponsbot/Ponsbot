import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, formatEther, formatUnits, keccak256, parseAbi, parseAbiParameters, parseEther, parseTransaction, parseUnits, recoverTransactionAddress, serializeTransaction, TransactionNotFoundError, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID, type AutomatedFeeBroadcastRequest, type AutomatedFeeClaimableRequest, type AutomatedFeeControllerBroadcastRequest, type AutomatedFeeControllerStatusRequest, type AutomatedFeeControllerSweepRequest, type AutomatedFeeControllerSweepStatusRequest, type AutomatedFeeControllerTransactionRequest, type AutomatedFeeDeliveryTransactionRequest, type AutomatedFeeEnrollmentVerificationRequest, type AutomatedFeeInspectionRequest, type AutomatedFeeKeeperTransactionRequest, type AutomatedFeePairRouteBroadcastRequest, type AutomatedFeePairRouteRequest, type AutomatedFeeQuoteRequest, type AutomatedFeeSweepTransactionRequest, type AutomatedFeeTransactionStatusRequest, type AutomatedFeeVaultDeploymentRequest, type AutomatedFeeVaultDeploymentStatusRequest, type AutomatedFeeVaultPredictionRequest, type BroadcastRequest, type ExecutionRequest, type TransactionStatusRequest } from "./policy";
import { checkedUsdToEthWei, ethUsdPrice } from "./pricing";
import { estimateActualFees, estimateResilientAutomationFees, insufficientGasError, recheckLaunchGas, sendAllGasReserve, spendableEthAfterGas, sponsoredLaunchCost, transactionGasEnvelope, transactionMaximumCost } from "./gas";
import { requireNativeGasBalance, requireWalletNativeGas } from "../wallet-native-gas";
import { nativeTokenOperationError } from "../native-token-operation";
import { reliableHttp, resilientRobinhoodHttp } from "../rpc-http";
import { rememberWalletExecutionCache, sharedWalletExecutionCache, walletExecutionCacheKey } from "../shared-wallet-execution-cache";
import { tokenMarketCapUsd, tokenUnitPriceUsd } from "../token-market-cap";
import { geckoTokenMarkets, GECKO_TOKEN_BATCH_SIZE } from "../gecko-token-market";
import { balanceWithUsd } from "../balance-display";
import { indexedNativeV4Pools, type IndexedV4PoolKey } from "../indexed-v4-routes";
import { PONS_PAIR_CATALOG } from "../pair-catalog";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../automated-fee-pair-routes";
import { inspectFeeAccumulation } from "./fee-accumulation";
import { curveSweepIsEmpty } from "./legacy-fee-preflight";
import type { LiquidityTransaction } from "../liquidity-contracts";

const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
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
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function pairTokenEconomics(address token) view returns ((uint256 phantomQuote,uint256 graduationThreshold,uint8 decimals))",
  "function launchDeployer() view returns (address)",
  "function buybackVault() view returns (address)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function transferCreatorFeeRecipient(address token,address newRecipient)",
  "event CreatorFeeRecipientUpdated(address indexed token,address indexed previousRecipient,address indexed newRecipient)",
]);
const holderDistributorFactoryAbi = parseAbi([
  "function createFor(address token) returns (address distributor)",
  "function distributorOf(address token) view returns (address)",
  "event DistributorCreated(address indexed token,address indexed distributor)",
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
  "function sweepFees(uint256 minBuybackTokensOut)",
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
const ponsLaunchDeployerAbi = parseAbi([
  "function predictLaunchAddresses((address pairToken,address creatorFeeRecipient,address originalDeployer,address feePolicy,(address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps) policy,address feeEscrow,address buybackVault,uint256 phantomQuote,uint256 curveFeeBps,uint256 creatorTaxBps,bool buybackEnabled,uint256 graduationThreshold,uint256 supply,bytes32 salt,string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials)) view returns (address token,address curve)",
]);
const ponsMemeHookPolicyAbi = parseAbi(["function currentFeePolicy() view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))"]);
const automatedFeeVaultAbi = parseAbi([
  "function pairAsset() view returns (address)",
  "function token() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function executionNonce() view returns (uint256)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function controller() view returns (address)",
  "function beneficiary() view returns (address)",
  "function claimable(address beneficiary,address asset) view returns (uint256)",
  "function lastCurveSweepBlock() view returns (uint256)",
  "function lastGraduatedSweepBlock() view returns (uint256)",
  "function sweepCurveFees(uint256 minBuybackTokensOut)",
  "function sweepGraduatedFees(uint256 minConversionQuoteOut,uint256 minBuybackTokensOut)",
  "function processFees((uint256 maxBuybackAmount,uint256 minPonsbotOut,uint256 minSweepBuybackTokensOut,uint256 deadline,address routeTarget,bytes routeData,bytes quoteSignature) execution) returns (uint256 gross,uint256 burned)",
  "function deliverBeneficiaryAllocation(address beneficiaryAddress,address asset,uint256 amount)",
  "event FeesProcessed(address indexed asset,uint256 grossClaimed,uint256 beneficiaryAllocated,uint256 buybackSpent,uint256 ponsbotBurned)",
  "event CurveFeesSwept(address indexed token,uint256 indexed blockNumber,uint256 minBuybackTokensOut)",
  "event GraduatedFeesSwept(address indexed token,bytes32 indexed poolId,uint256 indexed blockNumber,uint256 minConversionQuoteOut,uint256 minBuybackTokensOut)",
  "event BeneficiaryAllocationDelivered(address indexed beneficiary,address indexed asset,uint256 amount)",
  "event BeneficiaryWithdrawal(address indexed beneficiary,address indexed asset,address indexed recipient,uint256 amount)",
  "function pause()",
  "function exit(address newPonsFeeRecipient)",
  "function withdraw(address asset,address recipient,uint256 amount)",
  "function settleAndReassign(address newController,address newBeneficiary,(uint256 maxBuybackAmount,uint256 minPonsbotOut,uint256 minSweepBuybackTokensOut,uint256 deadline,address routeTarget,bytes routeData,bytes quoteSignature) execution) returns (uint256 gross,uint256 burned)",
]);
const automatedFeeVaultFactoryAbi = parseAbi([
  "function deployVault(bytes32 salt,(address token,address curve,address pairAsset,address ponsFactory,address feeEscrow,address ponsbot,address controller,address beneficiary,address feeControl) init) returns (address vault)",
  "function predictVaultAddress(bytes32 salt) view returns (address)",
  "function isVault(address candidate) view returns (bool)",
  "function approvedFeeEscrow(address ponsFactoryAddress) view returns (address)",
  "function implementation() view returns (address)",
  "function feeControl() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function ponsbot() view returns (address)",
]);
const automatedFeePairedExecutorAbi = parseAbi([
  "function pairRoutes(address pairAsset) view returns (uint8 kind,uint24 fee,int24 tickSpacing,address hook,bytes32 hookCodeHash)",
  "function configurePairRoute(address pairAsset,uint8 kind,uint24 fee,int24 tickSpacing,address hook)",
]);
const automatedFeeControlAbi = parseAbi([
  "function processingEnabled() view returns (bool)", "function admin() view returns (address)",
  "function pauseGuardian() view returns (address)", "function keeper() view returns (address)",
  "function quoteAuthorizer() view returns (address)", "function executionAdapter() view returns (address)",
]);
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const V3_FEES = [100, 500, 3_000, 10_000] as const;
const ROUTE_MEMORY_CACHE_MS = 60 * 60_000;
const ROUTE_SHARED_CACHE_MS = 7 * 24 * 60 * 60_000;
const TOKEN_METADATA_CACHE_MS = 7 * 24 * 60 * 60_000;
const routeCache = new Map<string, { path: Hex; expiresAt: number }>();
const tokenMetadataCache = new Map<string, { symbol: string; name: string; decimals: number; expiresAt: number }>();
const ponsPairCache = new Map<string, { value: CachedPonsLaunch | null; expiresAt: number }>();
let cdpClient: CdpClient | undefined;

type CachedPonsLaunch = {
  token: Address; curve: Address; deployer: Address; creatorFeeRecipient: Address; pairToken: Address;
  graduationThreshold: bigint; poolFee: number; tickSpacing: number; creatorTaxBps: number;
  buybackEnabled: boolean; phase: number; sweptQuote: bigint; sweptTokens: bigint; sweptAt: bigint; exists: boolean;
};

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

function requiredAddress(name: string) {
  const value = required(name);
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${name} is not a valid address`);
  return value as Address;
}

function rpcClient() {
  return createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL || PUBLIC_ROBINHOOD_RPC_URL) });
}

function manualAutomatedFeeAllowlist() {
  if (process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("automated fee manual testing is disabled");
  }
  if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") {
    throw new Error("manual automated fee endpoints are unavailable while automatic processing is enabled");
  }
  const tokens = new Set(
    (process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (tokens.size === 0 || [...tokens].some((value) => !/^0x[a-f0-9]{40}$/.test(value))) {
    throw new Error("automated fee manual-test token allowlist is missing or invalid");
  }
  return tokens;
}

export async function assertAutomatedFeeManualAccess(input: { vaultAddress?: string; tokenAddress?: string }) {
  const allowlist = manualAutomatedFeeAllowlist();
  let token = input.tokenAddress?.toLowerCase();
  if (!token && input.vaultAddress) {
    const client = rpcClient();
    const vault = input.vaultAddress as Address;
    const factory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
    const [registered, vaultToken] = await Promise.all([
      client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "isVault", args: [vault] }),
      client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "token" }),
    ]);
    if (!registered) throw new Error("automated fee vault is not registered by the configured factory");
    token = vaultToken.toLowerCase();
  }
  if (!token || !allowlist.has(token)) throw new Error("token is not allowlisted for automated fee manual testing");
  return token as Address;
}

export async function assertAutomatedFeeExecutionAccess(input: { vaultAddress?: string; tokenAddress?: string }) {
  const productionEnabled = process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true"
    && process.env.AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true";
  if (!productionEnabled) return assertAutomatedFeeManualAccess(input);

  let token = input.tokenAddress?.toLowerCase();
  if (input.vaultAddress) {
    const client = rpcClient();
    const vault = input.vaultAddress as Address;
    const factory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
    const [registered, vaultToken] = await Promise.all([
      client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "isVault", args: [vault] }),
      client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "token" }),
    ]);
    if (!registered) throw new Error("automated fee vault is not registered by the configured factory");
    if (token && token !== vaultToken.toLowerCase()) throw new Error("automated fee vault token mismatch");
    token = vaultToken.toLowerCase();
  }
  if (!token || !/^0x[a-f0-9]{40}$/.test(token)) throw new Error("automated fee token is missing or invalid");
  return token as Address;
}

function automatedFeeCapabilityEnabled(name: "AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED" | "AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED" | "AUTOMATED_FEE_BOT_COMMANDS_ENABLED") {
  return process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true"
    && process.env[name]?.trim().toLowerCase() === "true";
}

function automatedFeeRecoveryAccessConfigured() {
  return Boolean(process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim())
    && /^0x[a-fA-F0-9]{40}$/.test(process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?.trim() ?? "");
}

export async function assertAutomatedFeeEnrollmentAccess(input: { tokenAddress: string; source: "new_launch" | "upgrade" }) {
  const capability = input.source === "new_launch" ? "AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED" : "AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED";
  if (!automatedFeeCapabilityEnabled(capability) && !automatedFeeRecoveryAccessConfigured()) {
    return assertAutomatedFeeManualAccess({ tokenAddress: input.tokenAddress });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.tokenAddress)) throw new Error("automated fee enrollment token is invalid");
  return input.tokenAddress.toLowerCase() as Address;
}

export async function assertAutomatedFeeControllerAccess(input: { vaultAddress: string }) {
  if (!automatedFeeCapabilityEnabled("AUTOMATED_FEE_BOT_COMMANDS_ENABLED") && !automatedFeeRecoveryAccessConfigured()) {
    return assertAutomatedFeeManualAccess(input);
  }
  const client = rpcClient();
  const factory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
  const vault = input.vaultAddress as Address;
  const [registered, token] = await Promise.all([
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "isVault", args: [vault] }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "token" }),
  ]);
  if (!registered) throw new Error("automated fee vault is not registered by the configured factory");
  return token;
}

export async function assertAutomatedFeeDeliveryAccess(input: { vaultAddress: string }) {
  if (automatedFeeCapabilityEnabled("AUTOMATED_FEE_BOT_COMMANDS_ENABLED") || automatedFeeRecoveryAccessConfigured()) {
    return assertAutomatedFeeControllerAccess(input);
  }
  return assertAutomatedFeeExecutionAccess(input);
}

export function assertAutomatedFeeEnrollmentProof(headers: Headers, path: string, vaultAddress: string, body: unknown) {
  const productionEnabled = process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true"
    && ["AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED", "AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED", "AUTOMATED_FEE_BOT_COMMANDS_ENABLED"]
      .some((name) => process.env[name]?.trim().toLowerCase() === "true");
  // Once a shared proof secret is configured, it also protects recovery calls
  // made after a public capability switch is turned off. Manual testing keeps
  // its previous bearer-plus-allowlist behavior when no proof secret exists.
  if (!productionEnabled && !process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim()) return;
  const timestamp = headers.get("x-automated-fee-timestamp") ?? "";
  const supplied = headers.get("x-automated-fee-proof") ?? "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000 || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new Error("automated fee enrollment proof is invalid");
  }
  const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const expected = createHmac("sha256", required("AUTOMATED_FEE_ENROLLMENT_SECRET"))
    .update(`${timestamp}:${path}:${vaultAddress.toLowerCase()}:${bodyDigest}`).digest("hex");
  const left = Buffer.from(supplied, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("automated fee enrollment proof is invalid");
}

function assertAutomatedFeePairRouteManualAccess(pairAsset: string) {
  // Reuse the fail-closed manual feature gate, but pair routes are configured
  // for the platform's canonical pair catalog rather than for a test launch.
  manualAutomatedFeeAllowlist();
  if (!PONS_PAIR_CATALOG.some(([address]) => address.toLowerCase() === pairAsset.toLowerCase())) {
    throw new Error("asset is not in the canonical Pons pair catalog");
  }
  const route = AUTOMATED_FEE_PAIR_ROUTES.find(
    (candidate) => candidate.pairAsset.toLowerCase() === pairAsset.toLowerCase(),
  );
  if (!route) throw new Error("asset has no reviewed automated fee route");
  return route;
}

const PUBLIC_ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

function rpcClientFor(url: string) {
  return createPublicClient({ transport: reliableHttp(url) });
}

async function transactionExists(client: ReturnType<typeof rpcClientFor>, hash: Hex) {
  try {
    const transaction = await client.getTransaction({ hash });
    return transaction.hash.toLowerCase() === hash.toLowerCase();
  } catch {
    return false;
  }
}

async function waitForBroadcastRetry(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
}

async function submitSignedTransaction(
  client: ReturnType<typeof rpcClientFor>,
  signed: Hex,
  localHash: Hex,
  attempts: number,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A previous submission may have succeeded even when its HTTP/JSON-RPC
    // response was lost. Never rebroadcast before checking the local hash.
    if (await transactionExists(client, localHash)) return localHash;
    try {
      return await client.sendRawTransaction({ serializedTransaction: signed });
    } catch (error) {
      lastError = error;
      if (await transactionExists(client, localHash)) return localHash;
      if (attempt < attempts - 1) await waitForBroadcastRetry(attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC rejected the signed transaction");
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

async function automatedFeeAccount(nameVariable: "AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME" | "AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME" | "AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME", expectedAddressVariable: "AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS" | "AUTOMATED_FEE_KEEPER_ADDRESS" | "AUTOMATED_FEE_ADMIN_ADDRESS") {
  const name = required(nameVariable);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) throw new Error(`${nameVariable} is invalid`);
  const account = await cdp().evm.getOrCreateAccount({ name });
  const expected = configuredAddress(expectedAddressVariable, account.address);
  if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`${expectedAddressVariable} does not match its CDP account`);
  return account;
}

async function quoteAutomatedFeeV4(
  client: ReturnType<typeof rpcClient>, factory: Address, launch: CachedPonsLaunch,
  input: Address, output: Address, amountIn: bigint, routeHook?: Address,
) {
  const hook = routeHook ?? await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" });
  const inputIsCurrency0 = BigInt(input) < BigInt(output);
  const poolKey = {
    currency0: inputIsCurrency0 ? input : output,
    currency1: inputIsCurrency0 ? output : input,
    fee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    hooks: hook,
  };
  const quote = await client.simulateContract({
    address: requiredAddress("PONS_V4_QUOTER_ADDRESS"),
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne: inputIsCurrency0, exactAmount: amountIn, hookData: "0x" }],
  });
  if (quote.result[0] === 0n) throw new Error("automated fee quote returned no output");
  return quote.result[0];
}

function automatedFeeSlippageBps() {
  const parsed = Number(process.env.AUTOMATED_FEE_QUOTE_SLIPPAGE_BPS ?? "300");
  if (!Number.isInteger(parsed) || parsed < 50 || parsed > 1_000) {
    throw new Error("AUTOMATED_FEE_QUOTE_SLIPPAGE_BPS must be between 50 and 1000");
  }
  return parsed;
}

export async function inspectAutomatedFeeVault(request: AutomatedFeeInspectionRequest) {
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const vault = request.vaultAddress as Address;
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [token, pairAsset, ponsFactory, controller, beneficiary, nonce, active, paused, lastCurveSweepBlock] = await Promise.all([
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "token", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "pairAsset", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "ponsFactory", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "controller", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "beneficiary", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "executionNonce", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "active", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "paused", blockNumber }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "lastCurveSweepBlock", blockNumber }),
  ]);
  const launched = await client.readContract({
    address: ponsFactory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token], blockNumber,
  });
  const feeEscrow = await client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "feeEscrow", blockNumber });
  const escrowBalance = pairAsset === zeroAddress
    ? await client.readContract({ address: feeEscrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [vault], blockNumber })
    : await client.readContract({ address: feeEscrow, abi: feeEscrowAbi, functionName: "balanceOfToken", args: [vault, pairAsset], blockNumber });
  const accumulation = request.includeAccumulation && (launched.phase === 0 || launched.phase === 2)
    ? await inspectFeeAccumulation({ client, blockNumber, factory: ponsFactory, escrow: escrowBalance, launch: launched,
        quoteNative: amount => quoteAutomatedFeePairNative(client, ponsFactory, launched, pairAsset, amount) })
    : undefined;
  return {
    ...accumulation,
    blockNumber: blockNumber.toString(), token, pairAsset, controller, beneficiary,
    executionNonce: nonce.toString(), active, paused, phase: Number(launched.phase),
    creatorFeeRecipient: launched.creatorFeeRecipient, escrowBalance: escrowBalance.toString(),
    lastCurveSweepBlock: lastCurveSweepBlock.toString(),
  };
}

async function quoteAutomatedFeePairNative(client: ReturnType<typeof rpcClient>, factory: Address,
  launch: CachedPonsLaunch, pairAsset: Address, amount: bigint) {
  const route = await client.readContract({ address: requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS"),
    abi: automatedFeePairedExecutorAbi, functionName: "pairRoutes", args: [pairAsset] });
  if (route[0] === 1) {
    const quote = await client.simulateContract({ address: requiredAddress("AUTOMATED_FEE_V3_QUOTER_ADDRESS"), abi: quoterAbi,
      functionName: "quoteExactInputSingle", args: [{ tokenIn: pairAsset, tokenOut: requiredAddress("AUTOMATED_FEE_WETH_ADDRESS"),
        amountIn: amount, fee: route[1], sqrtPriceLimitX96: 0n }] });
    return quote.result[0];
  }
  if (route[0] === 2) return quoteAutomatedFeeV4(client, factory,
    { ...launch, token: pairAsset, pairToken: zeroAddress, poolFee: route[1], tickSpacing: route[2] }, pairAsset, zeroAddress, amount, route[3]);
  throw new Error("AUTOMATED_FEE_ACCUMULATION_ROUTE_UNAVAILABLE");
}

export async function automatedFeeClaimableBalance(request: AutomatedFeeClaimableRequest) {
  await assertAutomatedFeeDeliveryAccess({ vaultAddress: request.vaultAddress });
  const amount = await rpcClient().readContract({
    address: request.vaultAddress as Address,
    abi: automatedFeeVaultAbi,
    functionName: "claimable",
    args: [request.beneficiary as Address, request.asset as Address],
  });
  return { amount: amount.toString() };
}

export async function predictAutomatedFeeVault(request: AutomatedFeeVaultPredictionRequest) {
  await assertAutomatedFeeEnrollmentAccess({ tokenAddress: request.tokenAddress, source: request.enrollmentSource });
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const factory = configuredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS", request.vaultFactoryAddress);
  const ponsFactory = request.ponsFactoryAddress as Address;
  const [vaultAddress, feeEscrow] = await Promise.all([
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "predictVaultAddress", args: [request.salt as Hex] }),
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "approvedFeeEscrow", args: [ponsFactory] }),
  ]);
  if (feeEscrow === zeroAddress) throw new Error("Pons factory is not approved by the automated fee vault factory");
  return { vaultAddress, feeEscrow, vaultFactoryAddress: factory, ponsFactoryAddress: ponsFactory };
}

export async function automatedFeeVaultDeploymentStatus(request: AutomatedFeeVaultDeploymentStatusRequest) {
  await assertAutomatedFeeEnrollmentAccess({ tokenAddress: request.tokenAddress, source: request.enrollmentSource });
  const client = rpcClient();
  const factory = configuredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS", request.vaultFactoryAddress);
  try {
    const receipt = await client.getTransactionReceipt({ hash: request.transactionHash as Hex });
    if (receipt.status !== "success") return { status: "reverted" as const, blockNumber: receipt.blockNumber.toString() };
    const registered = await client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "isVault", args: [request.vaultAddress as Address] });
    if (!registered) throw new Error("confirmed vault deployment did not register the predicted vault");
    return { status: "confirmed" as const, blockNumber: receipt.blockNumber.toString() };
  } catch (error) {
    if (!(error instanceof TransactionNotFoundError) && !(error instanceof TransactionReceiptNotFoundError)) throw error;
    if (request.transactionNonce !== undefined && request.broadcastAt) {
      const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
      const [latestNonce, pendingNonce] = await Promise.all([
        client.getTransactionCount({ address: admin, blockTag: "latest" }),
        client.getTransactionCount({ address: admin, blockTag: "pending" }),
      ]);
      if (latestNonce > request.transactionNonce || (Date.now() - request.broadcastAt > 20 * 60_000 && pendingNonce <= request.transactionNonce)) {
        return { status: "dropped" as const, latestNonce, pendingNonce };
      }
    }
    return { status: "pending" as const };
  }
}

export async function verifyAutomatedFeeEnrollment(request: AutomatedFeeEnrollmentVerificationRequest) {
  await assertAutomatedFeeEnrollmentAccess({ tokenAddress: request.tokenAddress, source: request.enrollmentSource });
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const vault = request.vaultAddress as Address;
  const factory = requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
  const [registered, deploymentReceipt, enrollmentReceipt, inspection] = await Promise.all([
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "isVault", args: [vault] }),
    client.getTransactionReceipt({ hash: request.deploymentTransactionHash as Hex }),
    client.getTransactionReceipt({ hash: request.enrollmentTransactionHash as Hex }),
    inspectAutomatedFeeVault({ chainId: ROBINHOOD_CHAIN_ID, vaultAddress: request.vaultAddress }),
  ]);
  if (!registered) throw new Error("automated fee vault is not registered by the configured factory");
  if (deploymentReceipt.status !== "success" || enrollmentReceipt.status !== "success") throw new Error("automated fee enrollment transaction reverted");
  if (inspection.token.toLowerCase() !== request.tokenAddress.toLowerCase()
    || inspection.controller.toLowerCase() !== request.controllerAddress.toLowerCase()
    || inspection.beneficiary.toLowerCase() !== request.beneficiaryAddress.toLowerCase()
    || inspection.pairAsset.toLowerCase() !== request.pairTokenAddress.toLowerCase()
    || inspection.creatorFeeRecipient.toLowerCase() !== request.vaultAddress.toLowerCase()
    || !inspection.active || inspection.paused) {
    throw new Error("automated fee enrollment live state mismatch");
  }
  return { verified: true as const, deploymentBlockNumber: deploymentReceipt.blockNumber.toString(), enrollmentBlockNumber: enrollmentReceipt.blockNumber.toString(), ...inspection };
}

export async function automatedFeeInfrastructureStatus() {
  const client = rpcClient();
  const requiredAddressVariables = [
    "AUTOMATED_FEE_CONTROL_ADDRESS", "AUTOMATED_FEE_VAULT_FACTORY_ADDRESS",
    "AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS", "AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS",
    "AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS", "AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS",
    "AUTOMATED_FEE_ADMIN_ADDRESS", "AUTOMATED_FEE_KEEPER_ADDRESS",
    "AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS", "AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS",
    "AUTOMATED_FEE_V3_ROUTER_ADDRESS", "AUTOMATED_FEE_V3_QUOTER_ADDRESS",
    "AUTOMATED_FEE_WETH_ADDRESS", "PONS_V2_FACTORY_ADDRESS", "PONSBOT_TOKEN_ADDRESS",
  ] as const;
  const missingConfiguration: string[] = requiredAddressVariables.filter((name) => !process.env[name]?.trim());
  const invalidConfiguration: string[] = requiredAddressVariables.filter((name) => {
    const value = process.env[name]?.trim();
    return Boolean(value) && !/^0x[a-fA-F0-9]{40}$/.test(value!);
  });
  for (const name of [
    "AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME",
    "AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_ENROLLMENT_SECRET",
  ] as const) {
    if (!process.env[name]?.trim()) missingConfiguration.push(name);
  }
  if (missingConfiguration.length || invalidConfiguration.length) {
    return {
      chainId: await client.getChainId(),
      configurationValid: false,
      missingConfiguration,
      invalidConfiguration,
      processingEnabled: null,
      productionRequested: process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true",
      processingRequested: process.env.AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true",
      balancesWei: {}, contractCode: {}, allContractsDeployed: false,
      controlMatches: false, factoryMatches: false,
      enrollmentProofConfigured: Boolean(process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim()),
      routes: [], allRoutesReady: false,
    };
  }
  const control = requiredAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
  const executor = requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS");
  const ponsFactory = requiredAddress("PONS_V2_FACTORY_ADDRESS");
  const contractAddresses = {
    control, vaultFactory: requiredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS"),
    vaultImplementation: requiredAddress("AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS"),
    adapter: requiredAddress("AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS"),
    nativeExecutor: requiredAddress("AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS"), pairedExecutor: executor,
  };
  const admin = requiredAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
  const keeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
  const quoteAuthorizer = requiredAddress("AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS");
  const guardian = requiredAddress("AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS");
  const [chainId, controlState, factoryState, currentPonsFeeEscrow, adminBalance, keeperBalance, quoteAuthorizerBalance, guardianBalance, routes, contractCode] = await Promise.all([
    client.getChainId(),
    Promise.all([
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "processingEnabled" }),
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "admin" }),
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "pauseGuardian" }),
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "keeper" }),
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "quoteAuthorizer" }),
      client.readContract({ address: control, abi: automatedFeeControlAbi, functionName: "executionAdapter" }),
    ]),
    Promise.all([
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "implementation" }),
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "feeControl" }),
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "ponsFactory" }),
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "feeEscrow" }),
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "ponsbot" }),
      client.readContract({ address: contractAddresses.vaultFactory, abi: automatedFeeVaultFactoryAbi, functionName: "approvedFeeEscrow", args: [ponsFactory] }),
    ]),
    client.readContract({ address: ponsFactory, abi: ponsFactoryAbi, functionName: "feeEscrow" }),
    client.getBalance({ address: admin }), client.getBalance({ address: keeper }), client.getBalance({ address: quoteAuthorizer }), client.getBalance({ address: guardian }),
    Promise.all(AUTOMATED_FEE_PAIR_ROUTES.map(async (reviewed) => {
      const configured = await client.readContract({ address: executor, abi: automatedFeePairedExecutorAbi, functionName: "pairRoutes", args: [reviewed.pairAsset] });
      const expectedKind = reviewed.kind === "v3" ? 1 : 2;
      const expectedHookHash = reviewed.hook === zeroAddress ? `0x${"0".repeat(64)}` : keccak256(await client.getCode({ address: reviewed.hook }) || "0x");
      const matches = Number(configured[0]) === expectedKind && Number(configured[1]) === reviewed.fee
        && Number(configured[2]) === reviewed.tickSpacing && configured[3].toLowerCase() === reviewed.hook.toLowerCase()
        && configured[4].toLowerCase() === expectedHookHash.toLowerCase();
      return { symbol: reviewed.symbol, pairAsset: reviewed.pairAsset, configured: Number(configured[0]) !== 0, matches };
    })), Promise.all(Object.entries(contractAddresses).map(async ([name, address]) => [name, Boolean(await client.getCode({ address }))] as const)),
  ]);
  const processingEnabled = controlState[0];
  const controlMatches = controlState[1].toLowerCase() === admin.toLowerCase()
    && controlState[2].toLowerCase() === guardian.toLowerCase()
    && controlState[3].toLowerCase() === keeper.toLowerCase()
    && controlState[4].toLowerCase() === quoteAuthorizer.toLowerCase()
    && controlState[5].toLowerCase() === contractAddresses.adapter.toLowerCase();
  const factoryMatches = factoryState[0].toLowerCase() === contractAddresses.vaultImplementation.toLowerCase()
    && factoryState[1].toLowerCase() === control.toLowerCase()
    && factoryState[2].toLowerCase() === ponsFactory.toLowerCase()
    && factoryState[3].toLowerCase() === currentPonsFeeEscrow.toLowerCase()
    && factoryState[4].toLowerCase() === requiredAddress("PONSBOT_TOKEN_ADDRESS").toLowerCase()
    && factoryState[5].toLowerCase() === currentPonsFeeEscrow.toLowerCase();
  return {
    chainId, processingEnabled, configurationValid: true,
    missingConfiguration: [], invalidConfiguration: [],
    productionRequested: process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true",
    processingRequested: process.env.AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true",
    balancesWei: { admin: adminBalance.toString(), keeper: keeperBalance.toString(), quoteAuthorizer: quoteAuthorizerBalance.toString(), guardian: guardianBalance.toString() },
    contractCode: Object.fromEntries(contractCode), allContractsDeployed: contractCode.every(([, present]) => present),
    controlMatches, factoryMatches, factoryFeeEscrow: factoryState[3], currentPonsFeeEscrow,
    enrollmentProofConfigured: Boolean(process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim()),
    routes, allRoutesReady: routes.every((route) => route.matches),
  };
}

export async function authorizeAutomatedFeeQuote(request: AutomatedFeeQuoteRequest) {
  await assertAutomatedFeeExecutionAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (request.deadline < now + 15 || request.deadline > now + 10 * 60) throw new Error("automated fee quote deadline is invalid");
  const vault = request.vaultAddress as Address;
  const [pairAsset, tokenAddress, ponsFactory, feeEscrow, nonce, active, paused, lastCurveSweepBlock] = await Promise.all([
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "pairAsset" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "token" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "ponsFactory" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "feeEscrow" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "executionNonce" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "active" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "paused" }),
    client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "lastCurveSweepBlock" }),
  ]);
  if (!active || paused) throw new Error("automated fee vault is not processable");
  if (nonce.toString() !== request.nonce) {
    throw new Error("automated fee quote state changed");
  }
  const [launched, escrowBalance] = await Promise.all([
    client.readContract({ address: ponsFactory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [tokenAddress] }),
    pairAsset === zeroAddress
      ? client.readContract({ address: feeEscrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [vault] })
      : client.readContract({ address: feeEscrow, abi: feeEscrowAbi, functionName: "balanceOfToken", args: [vault, pairAsset] }),
  ]);
  if (!launched.exists || launched.creatorFeeRecipient.toLowerCase() !== vault.toLowerCase()) throw new Error("automated fee vault no longer controls the launch");
  if (launched.phase !== 0 && launched.phase !== 2) throw new Error("token graduation is still settling; retry this fee cycle shortly");
  if (launched.phase === 0 && lastCurveSweepBlock === 0n) {
    throw new Error("bonding-curve automated fees require a confirmed sweep before quoting");
  }
  const quotedBuybackAmount = escrowBalance * 500n / 10_000n;
  if (quotedBuybackAmount === 0n) throw new Error("no processable automated creator fees");
  // Permit small accruals between quote and mining without authorizing an
  // unbounded spend. Output minima remain based on the observed amount.
  const maxBuybackAmount = quotedBuybackAmount * 10_500n / 10_000n + 1n;
  const ponsbot = configuredAddress("PONSBOT_TOKEN_ADDRESS", "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07");
  const ponsbotLaunch = await client.readContract({ address: ponsFactory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [ponsbot] });
  if (!ponsbotLaunch.exists || ponsbotLaunch.phase !== 2 || ponsbotLaunch.pairToken !== zeroAddress) {
    throw new Error("canonical PONSBOT graduated pool is unavailable");
  }
  const slippageBps = automatedFeeSlippageBps();
  let routeData: Hex = "0x";
  let nativeForPonsbot = quotedBuybackAmount;
  const routeTarget = pairAsset === zeroAddress
    ? requiredAddress("AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS")
    : requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS");
  if (pairAsset !== zeroAddress) {
    const pairedExecutor = requiredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS");
    const configuredRoute = await client.readContract({
      address: pairedExecutor, abi: automatedFeePairedExecutorAbi, functionName: "pairRoutes", args: [pairAsset],
    });
    let quotedNative: bigint;
    if (configuredRoute[0] === 1) {
      const quote = await client.simulateContract({
        address: requiredAddress("AUTOMATED_FEE_V3_QUOTER_ADDRESS"), abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: pairAsset, tokenOut: requiredAddress("AUTOMATED_FEE_WETH_ADDRESS"), amountIn: quotedBuybackAmount,
          fee: configuredRoute[1], sqrtPriceLimitX96: 0n,
        }],
      });
      quotedNative = quote.result[0];
    } else if (configuredRoute[0] === 2) {
      const routeLaunch = {
        ...ponsbotLaunch, token: pairAsset, pairToken: zeroAddress,
        poolFee: configuredRoute[1], tickSpacing: configuredRoute[2],
      } as CachedPonsLaunch;
      quotedNative = await quoteAutomatedFeeV4(
        client, ponsFactory, routeLaunch, pairAsset, zeroAddress, quotedBuybackAmount, configuredRoute[3],
      );
    } else {
      throw new Error("paired asset has no approved automated buyback route");
    }
    nativeForPonsbot = quotedNative * BigInt(10_000 - slippageBps) / 10_000n;
    if (nativeForPonsbot === 0n) throw new Error("paired automated fee quote is below minimum output");
    routeData = encodeAbiParameters(parseAbiParameters("uint256 minNativeOut"), [nativeForPonsbot]);
  }
  const quotedPonsbot = await quoteAutomatedFeeV4(client, ponsFactory, ponsbotLaunch, zeroAddress, ponsbot, nativeForPonsbot);
  const minPonsbotOut = quotedPonsbot * BigInt(10_000 - slippageBps) / 10_000n;
  if (minPonsbotOut === 0n) throw new Error("automated PONSBOT quote is below minimum output");
  const minSweepBuybackTokensOut = 0n;
  const account = await automatedFeeAccount("AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS");
  if ((await client.getCode({ address: account.address })) !== undefined) throw new Error("automated fee quote authorizer must be an EOA");
  const signature = await account.signTypedData({
    domain: { name: "PonsBotFeeVault", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: vault },
    types: {
      ExecutionAuthorization: [
        { name: "pairAsset", type: "address" },
        { name: "maxBuybackAmount", type: "uint256" },
        { name: "minPonsbotOut", type: "uint256" },
        { name: "minSweepBuybackTokensOut", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "routeTarget", type: "address" },
        { name: "routeDataHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "ExecutionAuthorization",
    message: {
      pairAsset,
      maxBuybackAmount,
      minPonsbotOut,
      minSweepBuybackTokensOut,
      deadline: BigInt(request.deadline),
      routeTarget,
      routeDataHash: keccak256(routeData),
      nonce,
    },
  });
  return {
    signature, authorizer: account.address, nonce: nonce.toString(), deadline: request.deadline,
    pairAsset, grossClaimEstimate: escrowBalance.toString(), maxBuybackAmount: maxBuybackAmount.toString(),
    minPonsbotOut: minPonsbotOut.toString(), minSweepBuybackTokensOut: "0", routeTarget, routeData,
  };
}

export async function prepareAutomatedFeeTransaction(request: AutomatedFeeKeeperTransactionRequest) {
  await assertAutomatedFeeExecutionAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  const account = await automatedFeeAccount("AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_KEEPER_ADDRESS");
  const vault = request.vaultAddress as Address;
  const data = encodeFunctionData({
    abi: automatedFeeVaultAbi,
    functionName: "processFees",
    args: [{
      maxBuybackAmount: BigInt(request.maxBuybackAmount), minPonsbotOut: BigInt(request.minPonsbotOut),
      minSweepBuybackTokensOut: BigInt(request.minSweepBuybackTokensOut), deadline: BigInt(request.deadline),
      routeTarget: request.routeTarget as Address, routeData: request.routeData as Hex,
      quoteSignature: request.quoteSignature as Hex,
    }],
  });
  await client.call({ account: account.address, to: vault, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: vault, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee keeper has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: vault, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: vault, nonce };
}

export async function prepareAutomatedFeeSweepTransaction(request: AutomatedFeeSweepTransactionRequest) {
  await assertAutomatedFeeExecutionAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  const account = await automatedFeeAccount("AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_KEEPER_ADDRESS");
  const vault = request.vaultAddress as Address;
  const data = request.sweepKind === "curve"
    ? encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "sweepCurveFees", args: [BigInt(request.minBuybackTokensOut)] })
    : encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "sweepGraduatedFees", args: [BigInt(request.minConversionQuoteOut), BigInt(request.minBuybackTokensOut)] });
  try {
    await client.call({ account: account.address, to: vault, data });
  } catch (error) {
    // A positive minimum can legitimately fail when no fees (or only dust)
    // are available. Confirm that the zero-minimum call itself is a valid
    // no-op, but do not sign or broadcast that weaker transaction.
    const zeroMinimumData = request.sweepKind === "curve"
      ? encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "sweepCurveFees", args: [0n] })
      : encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "sweepGraduatedFees", args: [0n, 0n] });
    try {
      await client.call({ account: account.address, to: vault, data: zeroMinimumData });
      return { noFees: true as const, blockNumber: (await client.getBlockNumber()).toString() };
    } catch {
      throw error;
    }
  }
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: vault, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee keeper has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: vault, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: vault, nonce };
}

export async function prepareAutomatedFeeDeliveryTransaction(request: AutomatedFeeDeliveryTransactionRequest) {
  await assertAutomatedFeeDeliveryAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  const account = await automatedFeeAccount("AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_KEEPER_ADDRESS");
  const vault = request.vaultAddress as Address;
  const available = await client.readContract({
    address: vault, abi: automatedFeeVaultAbi, functionName: "claimable",
    args: [request.beneficiary as Address, request.asset as Address],
  });
  if (BigInt(request.amount) > available) {
    const requiredPreviouslyDelivered = BigInt(request.amount) - available;
    const events = await client.getContractEvents({
      address: vault, abi: automatedFeeVaultAbi, eventName: "BeneficiaryWithdrawal",
      args: { beneficiary: request.beneficiary as Address, asset: request.asset as Address },
      fromBlock: BigInt(request.processingBlockNumber), toBlock: "latest",
    });
    const previouslyDelivered = events.reduce((sum, event) => sum + (event.args.amount ?? 0n), 0n);
    if (previouslyDelivered >= requiredPreviouslyDelivered) {
      return { alreadyDelivered: true as const, deliveredAmount: request.amount, blockNumber: (await client.getBlockNumber()).toString() };
    }
    throw new Error("AUTOMATED_FEE_DELIVERY_CLAIMABLE_MISMATCH");
  }
  const data = encodeFunctionData({
    abi: automatedFeeVaultAbi, functionName: "deliverBeneficiaryAllocation",
    args: [request.beneficiary as Address, request.asset as Address, BigInt(request.amount)],
  });
  await client.call({ account: account.address, to: vault, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: vault, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee keeper has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: vault, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: vault, nonce };
}

export async function prepareAutomatedFeeVaultDeployment(request: AutomatedFeeVaultDeploymentRequest) {
  await assertAutomatedFeeEnrollmentAccess({ tokenAddress: request.token, source: request.enrollmentSource });
  const client = rpcClient();
  const factory = configuredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS", request.vaultFactoryAddress);
  configuredAddress("AUTOMATED_FEE_CONTROL_ADDRESS", request.feeControl);
  if (request.ponsbot.toLowerCase() !== "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07".toLowerCase()) throw new Error("automated fee PONSBOT address mismatch");
  const [launched, approvedEscrow, predictedVault] = await Promise.all([
    client.readContract({ address: request.ponsFactory as Address, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [request.token as Address] }),
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "approvedFeeEscrow", args: [request.ponsFactory as Address] }),
    client.readContract({ address: factory, abi: automatedFeeVaultFactoryAbi, functionName: "predictVaultAddress", args: [request.salt as Hex] }),
  ]);
  if (approvedEscrow.toLowerCase() !== request.feeEscrow.toLowerCase()) {
    throw new Error("Pons factory and fee escrow are not an approved automated-fee stack");
  }
  if (!launched.exists || launched.curve.toLowerCase() !== request.curve.toLowerCase()
    || launched.pairToken.toLowerCase() !== request.pairAsset.toLowerCase()
    || (launched.creatorFeeRecipient.toLowerCase() !== request.controller.toLowerCase()
      && launched.creatorFeeRecipient.toLowerCase() !== predictedVault.toLowerCase())) {
    throw new Error("existing-token upgrade no longer matches Pons state or controller");
  }
  const account = await automatedFeeAccount("AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_ADMIN_ADDRESS");
  const init = {
    token: request.token as Address, curve: request.curve as Address, pairAsset: request.pairAsset as Address,
    ponsFactory: request.ponsFactory as Address, feeEscrow: request.feeEscrow as Address, ponsbot: request.ponsbot as Address,
    controller: request.controller as Address, beneficiary: request.beneficiary as Address, feeControl: request.feeControl as Address,
  };
  const data = encodeFunctionData({ abi: automatedFeeVaultFactoryAbi, functionName: "deployVault", args: [request.salt as Hex, init] });
  await client.call({ account: account.address, to: factory, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: factory, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee admin has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: factory, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: factory, predictedVault, nonce };
}

export async function prepareAutomatedFeePairRoute(request: AutomatedFeePairRouteRequest) {
  const reviewedRoute = assertAutomatedFeePairRouteManualAccess(request.pairAsset);
  if (request.routeKind !== reviewedRoute.kind || request.fee !== reviewedRoute.fee
    || request.tickSpacing !== reviewedRoute.tickSpacing || request.hook.toLowerCase() !== reviewedRoute.hook.toLowerCase()) {
    throw new Error("requested pair route does not match the reviewed route catalog");
  }
  const client = rpcClient();
  const executor = configuredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS", request.pairedExecutorAddress);
  const account = await automatedFeeAccount("AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_ADMIN_ADDRESS");
  const data = encodeFunctionData({
    abi: automatedFeePairedExecutorAbi, functionName: "configurePairRoute",
    args: [request.pairAsset as Address, request.routeKind === "v3" ? 1 : 2, request.fee, request.tickSpacing, request.hook as Address],
  });
  await client.call({ account: account.address, to: executor, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: executor, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee admin has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: executor, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: executor, nonce };
}

export async function broadcastAutomatedFeePairRoute(request: AutomatedFeePairRouteBroadcastRequest) {
  const reviewedRoute = assertAutomatedFeePairRouteManualAccess(request.pairAsset);
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedAdmin = configuredAddress("AUTOMATED_FEE_ADMIN_ADDRESS", sender);
  const expectedExecutor = configuredAddress("AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS", request.vaultAddress);
  if (sender.toLowerCase() !== expectedAdmin.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || !parsed.data || parsed.to.toLowerCase() !== expectedExecutor.toLowerCase() || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee pair-route transaction envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeePairedExecutorAbi, data: parsed.data });
  if (decoded.functionName !== "configurePairRoute" || decoded.args[0].toLowerCase() !== request.pairAsset.toLowerCase()
    || Number(decoded.args[1]) !== (reviewedRoute.kind === "v3" ? 1 : 2)
    || Number(decoded.args[2]) !== reviewedRoute.fee || Number(decoded.args[3]) !== reviewedRoute.tickSpacing
    || decoded.args[4].toLowerCase() !== reviewedRoute.hook.toLowerCase()) {
    throw new Error("automated fee pair-route calldata mismatch");
  }
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

function automatedFeeControllerCalldata(operation: AutomatedFeeControllerTransactionRequest["operation"]) {
  if (operation.type === "pause") {
    return encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "pause" });
  }
  if (operation.type === "exit") {
    return encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "exit", args: [operation.recipient as Address] });
  }
  if (operation.type === "withdraw") {
    return encodeFunctionData({
      abi: automatedFeeVaultAbi, functionName: "withdraw",
      args: [operation.asset as Address, operation.recipient as Address, BigInt(operation.amount)],
    });
  }
  return encodeFunctionData({
    abi: automatedFeeVaultAbi, functionName: "settleAndReassign",
    args: [operation.newController as Address, operation.newBeneficiary as Address, {
      maxBuybackAmount: BigInt(operation.execution.maxBuybackAmount),
      minPonsbotOut: BigInt(operation.execution.minPonsbotOut),
      minSweepBuybackTokensOut: BigInt(operation.execution.minSweepBuybackTokensOut),
      deadline: BigInt(operation.execution.deadline), routeTarget: operation.execution.routeTarget as Address,
      routeData: operation.execution.routeData as Hex, quoteSignature: operation.execution.quoteSignature as Hex,
    }],
  });
}

export async function prepareAutomatedFeeControllerTransaction(request: AutomatedFeeControllerTransactionRequest) {
  await requireWalletNativeGas(request.expectedAddress);
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const expected = await provisionWallet(request.ownerReference);
  if (request.walletRef.toLowerCase() !== request.expectedAddress.toLowerCase()
    || expected.address.toLowerCase() !== request.expectedAddress.toLowerCase()) {
    throw new Error("automated fee controller wallet mismatch");
  }
  const client = rpcClient();
  const vault = request.vaultAddress as Address;
  if (request.operation.type === "withdraw") {
    if (request.operation.recipient.toLowerCase() !== request.expectedAddress.toLowerCase()) {
      throw new Error("automated fee withdrawal recipient must be the Pons Bot wallet");
    }
    const available = await client.readContract({
      address: vault, abi: automatedFeeVaultAbi, functionName: "claimable",
      args: [request.expectedAddress as Address, request.operation.asset as Address],
    });
    if (BigInt(request.operation.amount) > available) throw new Error("automated fee withdrawal exceeds claimable balance");
  } else {
    const currentController = await client.readContract({ address: vault, abi: automatedFeeVaultAbi, functionName: "controller" });
    if (currentController.toLowerCase() !== request.expectedAddress.toLowerCase()) {
      throw new Error("wallet no longer controls this automated fee vault");
    }
  }
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  if (account.address.toLowerCase() !== request.expectedAddress.toLowerCase()) throw new Error("automated fee controller CDP mismatch");
  const data = automatedFeeControllerCalldata(request.operation);
  await client.call({ account: account.address, to: vault, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: vault, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee controller has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: vault, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, from: account.address, to: vault, nonce };
}

export async function broadcastAutomatedFeeControllerTransaction(request: AutomatedFeeControllerBroadcastRequest) {
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const expected = await provisionWallet(request.ownerReference);
  if (request.walletRef.toLowerCase() !== request.expectedAddress.toLowerCase()
    || expected.address.toLowerCase() !== request.expectedAddress.toLowerCase()) throw new Error("automated fee controller wallet mismatch");
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedData = automatedFeeControllerCalldata(request.operation);
  if (sender.toLowerCase() !== request.expectedAddress.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || parsed.to.toLowerCase() !== request.vaultAddress.toLowerCase() || parsed.data !== expectedData
    || (parsed.value ?? 0n) !== 0n) throw new Error("automated fee controller transaction envelope mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

export async function automatedFeeControllerTransactionStatus(request: AutomatedFeeControllerStatusRequest) {
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: request.transactionHash as Hex });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) {
      try {
        await client.getTransaction({ hash: request.transactionHash as Hex });
        return { status: "pending" as const, transactionKnown: true };
      } catch (transactionError) {
        if (!(transactionError instanceof TransactionNotFoundError)) throw transactionError;
      }
      if (request.transactionNonce !== undefined && request.broadcastAt !== undefined) {
        const sender = request.expectedAddress as Address;
        const [latestNonce, pendingNonce] = await Promise.all([
          client.getTransactionCount({ address: sender, blockTag: "latest" }),
          client.getTransactionCount({ address: sender, blockTag: "pending" }),
        ]);
        if (latestNonce > request.transactionNonce
          || (Date.now() - request.broadcastAt > 20 * 60_000 && pendingNonce <= request.transactionNonce)) {
          return { status: "dropped" as const, transactionKnown: false, latestNonce, pendingNonce };
        }
      }
      return { status: "pending" as const };
    }
    throw error;
  }
  if (receipt.status !== "success") return { status: "reverted" as const, blockNumber: receipt.blockNumber.toString() };
  const inspection = await inspectAutomatedFeeVault({ chainId: ROBINHOOD_CHAIN_ID, vaultAddress: request.vaultAddress });
  const matches = request.operation.type === "reassign"
    ? inspection.controller.toLowerCase() === request.operation.newController.toLowerCase()
      && inspection.beneficiary.toLowerCase() === request.operation.newBeneficiary.toLowerCase()
      && inspection.active && !inspection.paused
    : request.operation.type === "exit"
      ? !inspection.active && inspection.paused
        && inspection.creatorFeeRecipient.toLowerCase() === request.operation.recipient.toLowerCase()
      : inspection.paused;
  if (!matches) throw new Error("automated fee controller transaction live state mismatch");
  return { ...inspection, status: "confirmed" as const, blockNumber: receipt.blockNumber.toString() };
}

export async function prepareAutomatedFeeControllerSweep(request: AutomatedFeeControllerSweepRequest) {
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  const vault = request.vaultAddress as Address;
  const inspection = await inspectAutomatedFeeVault({ chainId: ROBINHOOD_CHAIN_ID, vaultAddress: request.vaultAddress });
  if (inspection.phase !== 0 || !inspection.active || inspection.paused) throw new Error("automated fee controller sweep is not applicable");
  const account = await automatedFeeAccount("AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME", "AUTOMATED_FEE_KEEPER_ADDRESS");
  const data = encodeFunctionData({ abi: automatedFeeVaultAbi, functionName: "sweepCurveFees", args: [0n] });
  await client.call({ account: account.address, to: vault, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: vault, data }), estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }), client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas)) throw new Error("automated fee keeper has insufficient ETH");
  const transaction = { chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to: vault, data, value: 0n, nonce,
    gas: gasEnvelope.gas, maxFeePerGas: gasEnvelope.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: serializeTransaction(transaction), idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), signedTransaction: signature, nonce };
}

export async function broadcastAutomatedFeeControllerSweep(request: AutomatedFeeBroadcastRequest) {
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedKeeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
  if (sender.toLowerCase() !== expectedKeeper.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || parsed.to?.toLowerCase() !== request.vaultAddress.toLowerCase() || !parsed.data || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee controller sweep envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeeVaultAbi, data: parsed.data });
  if (decoded.functionName !== "sweepCurveFees" || decoded.args[0] !== 0n) throw new Error("automated fee controller sweep calldata mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

export async function automatedFeeControllerSweepStatus(request: AutomatedFeeControllerSweepStatusRequest) {
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  try {
    const receipt = await client.getTransactionReceipt({ hash: request.transactionHash as Hex });
    if (receipt.status !== "success") return { status: "reverted" as const };
    const event = receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== request.vaultAddress.toLowerCase()) return false;
      try { return decodeEventLog({ abi: automatedFeeVaultAbi, data: log.data, topics: log.topics }).eventName === "CurveFeesSwept"; }
      catch { return false; }
    });
    if (!event) throw new Error("automated fee controller sweep receipt is missing its event");
    return { status: "confirmed" as const, blockNumber: receipt.blockNumber.toString() };
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) {
      try {
        await client.getTransaction({ hash: request.transactionHash as Hex });
        return { status: "pending" as const, transactionKnown: true };
      } catch (transactionError) {
        if (!(transactionError instanceof TransactionNotFoundError)) throw transactionError;
      }
      if (request.transactionNonce !== undefined && request.broadcastAt !== undefined) {
        const keeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
        const [latestNonce, pendingNonce] = await Promise.all([
          client.getTransactionCount({ address: keeper, blockTag: "latest" }),
          client.getTransactionCount({ address: keeper, blockTag: "pending" }),
        ]);
        if (latestNonce > request.transactionNonce
          || (Date.now() - request.broadcastAt > 20 * 60_000 && pendingNonce <= request.transactionNonce)) {
          return { status: "dropped" as const, transactionKnown: false, latestNonce, pendingNonce };
        }
      }
      return { status: "pending" as const };
    }
    throw error;
  }
}

export async function broadcastAutomatedFeeTransaction(request: AutomatedFeeBroadcastRequest) {
  await assertAutomatedFeeExecutionAccess({ vaultAddress: request.vaultAddress });
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedKeeper = configuredAddress("AUTOMATED_FEE_KEEPER_ADDRESS", sender);
  if (sender.toLowerCase() !== expectedKeeper.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || !parsed.data || parsed.to.toLowerCase() !== request.vaultAddress.toLowerCase() || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee signed transaction envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeeVaultAbi, data: parsed.data });
  if (decoded.functionName !== "processFees") throw new Error("automated fee keeper calldata mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  const hash = await submitSignedTransaction(rpcClient(), signed, localHash, 3);
  return { transactionHash: hash, status: "broadcast" as const };
}

export async function broadcastAutomatedFeeSweepTransaction(request: AutomatedFeeBroadcastRequest) {
  await assertAutomatedFeeExecutionAccess({ vaultAddress: request.vaultAddress });
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedKeeper = configuredAddress("AUTOMATED_FEE_KEEPER_ADDRESS", sender);
  if (sender.toLowerCase() !== expectedKeeper.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || !parsed.data || parsed.to.toLowerCase() !== request.vaultAddress.toLowerCase() || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee sweep transaction envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeeVaultAbi, data: parsed.data });
  const validCurve = decoded.functionName === "sweepCurveFees" && decoded.args[0] > 0n;
  const validGraduated = decoded.functionName === "sweepGraduatedFees"
    && decoded.args[0] > 0n && decoded.args[1] > 0n;
  if (!validCurve && !validGraduated) throw new Error("automated fee sweep calldata mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee sweep transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

export async function broadcastAutomatedFeeDeliveryTransaction(request: AutomatedFeeBroadcastRequest) {
  await assertAutomatedFeeDeliveryAccess({ vaultAddress: request.vaultAddress });
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedKeeper = configuredAddress("AUTOMATED_FEE_KEEPER_ADDRESS", sender);
  if (sender.toLowerCase() !== expectedKeeper.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || !parsed.data || parsed.to.toLowerCase() !== request.vaultAddress.toLowerCase() || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee delivery transaction envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeeVaultAbi, data: parsed.data });
  if (decoded.functionName !== "deliverBeneficiaryAllocation") throw new Error("automated fee delivery calldata mismatch");
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

export async function automatedFeeTransactionStatus(request: AutomatedFeeTransactionStatusRequest) {
  // Read-only reconciliation remains available after the execution kill switch.
  await assertAutomatedFeeControllerAccess({ vaultAddress: request.vaultAddress });
  const client = rpcClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: request.transactionHash as Hex });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) {
      try {
        await client.getTransaction({ hash: request.transactionHash as Hex });
        return { status: "pending" as const, transactionKnown: true };
      } catch (transactionError) {
        if (!(transactionError instanceof TransactionNotFoundError)) throw transactionError;
      }
      if (request.transactionNonce !== undefined && request.broadcastAt !== undefined) {
        const keeper = requiredAddress("AUTOMATED_FEE_KEEPER_ADDRESS");
        const [latestNonce, pendingNonce] = await Promise.all([
          client.getTransactionCount({ address: keeper, blockTag: "latest" }),
          client.getTransactionCount({ address: keeper, blockTag: "pending" }),
        ]);
        if (latestNonce > request.transactionNonce
          || (Date.now() - request.broadcastAt > 20 * 60_000 && pendingNonce <= request.transactionNonce)) {
          return { status: "dropped" as const, transactionKnown: false, latestNonce, pendingNonce };
        }
      }
      return { status: "pending" as const };
    }
    throw error;
  }
  const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
  if (receipt.status !== "success") return { status: "reverted" as const, blockNumber: receipt.blockNumber.toString(), gasCostWei };
  const decoded = receipt.logs
    .filter((log) => log.address.toLowerCase() === request.vaultAddress.toLowerCase())
    .flatMap((log) => {
      try { return [decodeEventLog({ abi: automatedFeeVaultAbi, data: log.data, topics: log.topics })]; }
      catch { return []; }
    });
  if (request.stage === "processing") {
    const event = decoded.find((item) => item.eventName === "FeesProcessed");
    if (!event || event.eventName !== "FeesProcessed") throw new Error("confirmed automated fee processing receipt is missing its event");
    return { status: "confirmed" as const, blockNumber: receipt.blockNumber.toString(),
      grossClaimed: event.args.grossClaimed.toString(), beneficiaryAllocated: event.args.beneficiaryAllocated.toString(),
      buybackSpent: event.args.buybackSpent.toString(), ponsbotBurned: event.args.ponsbotBurned.toString(), gasCostWei };
  }
  if (request.stage === "delivery") {
    const event = decoded.find((item) => item.eventName === "BeneficiaryAllocationDelivered");
    if (!event || event.eventName !== "BeneficiaryAllocationDelivered") throw new Error("confirmed automated fee delivery receipt is missing its event");
    return { status: "confirmed" as const, blockNumber: receipt.blockNumber.toString(),
      beneficiary: event.args.beneficiary, asset: event.args.asset, amount: event.args.amount.toString(), gasCostWei };
  }
  const event = decoded.find((item) => item.eventName === "CurveFeesSwept" || item.eventName === "GraduatedFeesSwept");
  if (!event) throw new Error("confirmed automated fee sweep receipt is missing its event");
  return { status: "confirmed" as const, blockNumber: receipt.blockNumber.toString(), gasCostWei, sweepKind: event.eventName === "CurveFeesSwept" ? "curve" as const : "graduated" as const };
}

export async function broadcastAutomatedFeeAdminTransaction(request: AutomatedFeeBroadcastRequest) {
  if (!request.tokenAddress) throw new Error("manual vault broadcast requires its allowlisted token address");
  await assertAutomatedFeeEnrollmentAccess({ tokenAddress: request.tokenAddress, source: request.enrollmentSource ?? "upgrade" });
  const signed = request.signedTransaction as Hex;
  const parsed = parseTransaction(signed);
  const sender = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  const expectedAdmin = configuredAddress("AUTOMATED_FEE_ADMIN_ADDRESS", sender);
  const expectedFactory = configuredAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS", request.vaultAddress);
  if (sender.toLowerCase() !== expectedAdmin.toLowerCase() || parsed.chainId !== ROBINHOOD_CHAIN_ID
    || !parsed.to || !parsed.data || parsed.to.toLowerCase() !== expectedFactory.toLowerCase() || (parsed.value ?? 0n) !== 0n) {
    throw new Error("automated fee admin transaction envelope mismatch");
  }
  const decoded = decodeFunctionData({ abi: automatedFeeVaultFactoryAbi, data: parsed.data });
  if (decoded.functionName !== "deployVault"
    || decoded.args[1].token.toLowerCase() !== request.tokenAddress.toLowerCase()) {
    throw new Error("automated fee admin calldata does not match its allowlisted token");
  }
  const localHash = keccak256(signed);
  if (localHash.toLowerCase() !== request.transactionHash.toLowerCase()) throw new Error("automated fee transaction hash mismatch");
  return { transactionHash: await submitSignedTransaction(rpcClient(), signed, localHash, 3), status: "broadcast" as const };
}

const MAX_FREE_LAUNCH_GRANT_WEI = 20_000_000_000_000_000n;

async function configuredFreeLaunchSponsorAccount() {
  const name = required("FREE_LAUNCH_SPONSOR_CDP_ACCOUNT_NAME");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) throw new Error("free launch sponsor account name is invalid");
  return cdp().evm.getOrCreateAccount({ name });
}

async function freeLaunchSponsorAccount() {
  if (process.env.FREE_LAUNCH_SPONSOR_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("free launch sponsorship is disabled");
  }
  return configuredFreeLaunchSponsorAccount();
}

export async function freeLaunchSponsorWallet() {
  const account = await freeLaunchSponsorAccount();
  return { address: account.address };
}

export async function sponsorFreeLaunch(input: { idempotencyKey: string; recipient: Address; amountWei: string }) {
  const value = BigInt(input.amountWei);
  if (value <= 0n || value > MAX_FREE_LAUNCH_GRANT_WEI) throw new Error("free launch grant amount is invalid");
  if (input.recipient === zeroAddress || input.recipient.toLowerCase() === DEAD.toLowerCase()) {
    throw new Error("free launch recipient is invalid");
  }
  const client = rpcClient();
  const account = await freeLaunchSponsorAccount();
  if (account.address.toLowerCase() === input.recipient.toLowerCase()) throw new Error("free launch recipient is invalid");
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: account.address, to: input.recipient, value }),
    estimateResilientAutomationFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.getBalance({ address: account.address }),
  ]);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  if (balance < transactionMaximumCost(value, estimatedGas, fees.maxFeePerGas)) {
    throw new Error("free launch sponsor has insufficient ETH");
  }
  const transaction = {
    chainId: ROBINHOOD_CHAIN_ID,
    type: "eip1559" as const,
    to: input.recipient,
    data: "0x" as Hex,
    value,
    nonce,
    gas: gasEnvelope.gas,
    maxFeePerGas: gasEnvelope.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const { signature } = await cdp().evm.signTransaction({
    address: account.address,
    transaction: serializeTransaction(transaction),
    idempotencyKey: `free-launch:${input.idempotencyKey}`,
  });
  const localHash = keccak256(signature);
  const primaryUrl = process.env.ROBINHOOD_RPC_URL || PUBLIC_ROBINHOOD_RPC_URL;
  const primary = rpcClientFor(primaryUrl);
  let hash: Hex | undefined;
  try {
    hash = await submitSignedTransaction(primary, signature, localHash, 3);
  } catch {
    if (primaryUrl.replace(/\/$/, "").toLowerCase() !== PUBLIC_ROBINHOOD_RPC_URL.toLowerCase()) {
      try {
        hash = await submitSignedTransaction(rpcClientFor(PUBLIC_ROBINHOOD_RPC_URL), signature, localHash, 2);
      } catch {}
    }
  }
  if (!hash && (await transactionExists(primary, localHash))) hash = localHash;
  if (!hash) throw new Error("free launch funding could not be broadcast");
  if (hash.toLowerCase() !== localHash.toLowerCase()) throw new Error("free launch funding hash mismatch");
  return { transactionHash: hash, status: "broadcast" as const, sponsorAddress: account.address };
}

export async function freeLaunchSponsorshipStatus(input: { transactionHash: string; recipient: Address; amountWei: string }) {
  const value = BigInt(input.amountWei);
  if (value <= 0n || value > MAX_FREE_LAUNCH_GRANT_WEI) throw new Error("free launch grant amount is invalid");
  const account = await configuredFreeLaunchSponsorAccount();
  const client = rpcClient();
  let transaction;
  try {
    transaction = await client.getTransaction({ hash: input.transactionHash as Hex });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return { transactionHash: input.transactionHash, status: "not_found" as const };
    }
    throw error;
  }
  if (transaction.from.toLowerCase() !== account.address.toLowerCase()
    || transaction.to?.toLowerCase() !== input.recipient.toLowerCase()
    || transaction.value !== value) throw new Error("free launch funding transaction mismatch");
  try {
    const receipt = await client.getTransactionReceipt({ hash: input.transactionHash as Hex });
    return {
      transactionHash: input.transactionHash,
      status: receipt.status === "success" ? "confirmed" as const : "reverted" as const,
    };
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return { transactionHash: input.transactionHash, status: "pending" as const };
    }
    throw error;
  }
}

export async function freeLaunchDevBuyEligibility(input: {
  address: Address;
  amount: string;
  unit: "eth" | "usd" | "pair";
  pairToken: Address;
}) {
  const nativePair = input.pairToken === zeroAddress;
  if (nativePair && input.unit === "pair") {
    throw new Error("an ETH-paired developer buy must use ETH or USD");
  }
  if (!nativePair && input.unit !== "pair") {
    throw new Error("a non-ETH developer buy must be funded in its paired asset before sponsorship");
  }
  const requiredWei = nativePair
    ? input.unit === "usd"
      ? await checkedUsdToEthWei(input.amount)
      : parseEther(input.amount)
    : parseUnits(input.amount, (await tokenMetadata(input.pairToken)).decimals);
  const balanceWei = nativePair
    ? await rpcClient().getBalance({ address: input.address })
    : await rpcClient().readContract({
      address: input.pairToken,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [input.address],
    });
  return {
    sufficient: balanceWei >= requiredWei,
    requiredWei: requiredWei.toString(),
    balanceWei: balanceWei.toString(),
  };
}

export async function walletBalance(address: `0x${string}`, token?: string, knownTokens: Address[] = []): Promise<{ display: string; raw?: string; decimals?: number; symbol?: string }> {
  const client = rpcClient();
  if (!token || /^eth$/i.test(token)) {
    const [ethRaw, ethPrice] = await Promise.all([
      client.getBalance({ address }),
      ethUsdPrice(AbortSignal.timeout(5_000)).catch(() => undefined),
    ]);
    const eth = formatEther(ethRaw);
    const ethDisplay = balanceWithUsd(`${trimDecimal(eth)} ETH`, ethPrice === undefined ? undefined : Number(eth) * ethPrice);
    if (token) return { display: ethDisplay, symbol: "ETH" };
    const holdings = [ethDisplay];
    const tokenAddresses = [...new Set(knownTokens.map((value) => value.toLowerCase()))] as Address[];
    const marketEntries = new Map<string, number>();
    for (let offset = 0; offset < tokenAddresses.length; offset += GECKO_TOKEN_BATCH_SIZE) {
      const batch = tokenAddresses.slice(offset, offset + GECKO_TOKEN_BATCH_SIZE);
      const markets = await geckoTokenMarkets(batch, { ttlMs: 60_000, timeoutMs: 5_000, allowStale: true, priority: "interactive" }).catch(() => new Map());
      for (const [key, value] of markets) if (value.priceUsd !== undefined) marketEntries.set(key, value.priceUsd);
    }
    const tokenHoldings = await Promise.all(tokenAddresses.map(async (tokenAddress) => {
      try {
        const [balance, metadata] = await Promise.all([
          client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
          tokenMetadata(tokenAddress),
        ]);
        if (balance <= 0n) return undefined;
        const amount = formatUnits(balance, metadata.decimals);
        let unitUsd = /^USDG$/i.test(metadata.symbol) ? 1 : marketEntries.get(tokenAddress.toLowerCase());
        if (unitUsd === undefined) unitUsd = await tokenUnitPriceUsd(tokenAddress, AbortSignal.timeout(5_000)).catch(() => undefined);
        return balanceWithUsd(`${trimDecimal(amount)} ${metadata.symbol}`, unitUsd === undefined ? undefined : Number(amount) * unitUsd);
      } catch { return undefined; }
    }));
    holdings.push(...tokenHoldings.filter((value): value is string => Boolean(value)));
    return { display: holdings.join("\n") };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) throw new Error("token lookup was not resolved by the registry");
  const tokenAddress = token as Address;
  const [balance, metadata, market] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
    tokenMetadata(tokenAddress),
    geckoTokenMarkets([tokenAddress], { ttlMs: 60_000, timeoutMs: 5_000, allowStale: true, priority: "interactive" }).catch(() => new Map()),
  ]);
  const amount = formatUnits(balance, metadata.decimals);
  let unitUsd = /^USDG$/i.test(metadata.symbol) ? 1 : market.get(tokenAddress.toLowerCase())?.priceUsd;
  if (unitUsd === undefined) unitUsd = await tokenUnitPriceUsd(tokenAddress, AbortSignal.timeout(5_000)).catch(() => undefined);
  return { display: balanceWithUsd(`${trimDecimal(amount)} ${metadata.symbol}`, unitUsd === undefined ? undefined : Number(amount) * unitUsd), raw: balance.toString(), decimals: metadata.decimals, symbol: metadata.symbol };
}

export async function spendableEthBalance(address: Address, reservedGasUnits: number, requestedEth?: string) {
  const client = rpcClient();
  const balance = await requireNativeGasBalance(() => client.getBalance({ address }));
  const fees = await estimateActualFees(client);
  const result = spendableEthAfterGas(
    balance,
    BigInt(reservedGasUnits),
    fees.maxFeePerGas,
    requestedEth === undefined ? undefined : parseEther(requestedEth),
  );
  return {
    raw: result.value.toString(),
    display: formatEther(result.value),
    gasReserveRaw: result.reserve.toString(),
  };
}

function trimDecimal(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 8).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

async function resolveToken(identifier: string) {
  const normalized = identifier.replace(/^\$/, "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) throw new Error("token lookup was not resolved by the registry");
  const address = normalized as Address;
  return { address, ...(await tokenMetadata(address)) };
}

async function tokenMetadata(address: Address) {
  const normalized = address.toLowerCase();
  const memory = tokenMetadataCache.get(normalized);
  if (memory && memory.expiresAt > Date.now()) return { symbol: memory.symbol, name: memory.name, decimals: memory.decimals };
  const key = walletExecutionCacheKey("token_metadata", normalized);
  const shared = await sharedWalletExecutionCache<{ symbol?: unknown; name?: unknown; decimals?: unknown }>(key, "token_metadata");
  if (shared && typeof shared.symbol === "string" && typeof shared.name === "string"
    && Number.isInteger(shared.decimals) && Number(shared.decimals) >= 0 && Number(shared.decimals) <= 255) {
    const value = { symbol: shared.symbol.slice(0, 64), name: shared.name.slice(0, 160), decimals: Number(shared.decimals) };
    tokenMetadataCache.set(normalized, { ...value, expiresAt: Date.now() + ROUTE_MEMORY_CACHE_MS });
    return value;
  }
  const client = rpcClient();
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address, abi: tokenAbi, functionName: "symbol" }),
    client.readContract({ address, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address, abi: tokenAbi, functionName: "name" }).catch(() => ""),
  ]);
  const value = { symbol: symbol.slice(0, 64), name: name.slice(0, 160), decimals };
  tokenMetadataCache.set(normalized, { ...value, expiresAt: Date.now() + ROUTE_MEMORY_CACHE_MS });
  await rememberWalletExecutionCache(key, "token_metadata", value, TOKEN_METADATA_CACHE_MS);
  return value;
}

async function resolveActivePonsCurve(token: Address, factory: Address, fresh = false) {
  const key = walletExecutionCacheKey("pons_pair", factory, token);
  if (!fresh) {
    const memory = ponsPairCache.get(key);
    if (memory && memory.expiresAt > Date.now()) return memory.value || undefined;
    const shared = await sharedWalletExecutionCache<Record<string, unknown>>(key, "pons_pair");
    if (shared) {
      const restored = restoreCachedPonsLaunch(shared);
      if (restored) {
        const ttl = restored.phase === 2 ? ROUTE_MEMORY_CACHE_MS : 15_000;
        ponsPairCache.set(key, { value: restored, expiresAt: Date.now() + ttl });
        return restored;
      }
    }
  }
  const launched = await rpcClient().readContract({
    address: factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token],
  });
  if (!launched.exists) {
    if (fresh) return undefined;
    ponsPairCache.set(key, { value: null, expiresAt: Date.now() + 10_000 });
    return undefined;
  }
  const value: CachedPonsLaunch = { ...launched };
  // Fee ownership is mutable. Fee workflows request a fresh read and must not
  // rely on or extend the long-lived cache used for immutable pair routing.
  if (fresh) return value;
  const ttl = value.phase === 2 ? 24 * 60 * 60_000 : 15_000;
  ponsPairCache.set(key, { value, expiresAt: Date.now() + Math.min(ttl, ROUTE_MEMORY_CACHE_MS) });
  await rememberWalletExecutionCache(key, "pons_pair", {
    ...value, graduationThreshold: value.graduationThreshold.toString(), sweptQuote: value.sweptQuote.toString(),
    sweptTokens: value.sweptTokens.toString(), sweptAt: value.sweptAt.toString(),
  }, ttl);
  return value;
}

function restoreCachedPonsLaunch(value: Record<string, unknown>): CachedPonsLaunch | undefined {
  const addresses = ["token", "curve", "deployer", "creatorFeeRecipient", "pairToken"] as const;
  if (!addresses.every((field) => typeof value[field] === "string" && /^0x[a-fA-F0-9]{40}$/.test(value[field] as string))) return undefined;
  if (!["graduationThreshold", "sweptQuote", "sweptTokens", "sweptAt"].every((field) => typeof value[field] === "string" && /^\d+$/.test(value[field] as string))) return undefined;
  if (!["poolFee", "tickSpacing", "creatorTaxBps", "phase"].every((field) => Number.isInteger(value[field]))) return undefined;
  if (typeof value.buybackEnabled !== "boolean" || value.exists !== true) return undefined;
  return {
    token: value.token as Address, curve: value.curve as Address, deployer: value.deployer as Address,
    creatorFeeRecipient: value.creatorFeeRecipient as Address, pairToken: value.pairToken as Address,
    graduationThreshold: BigInt(value.graduationThreshold as string), poolFee: Number(value.poolFee),
    tickSpacing: Number(value.tickSpacing), creatorTaxBps: Number(value.creatorTaxBps),
    buybackEnabled: value.buybackEnabled, phase: Number(value.phase), sweptQuote: BigInt(value.sweptQuote as string),
    sweptTokens: BigInt(value.sweptTokens as string), sweptAt: BigInt(value.sweptAt as string), exists: true,
  };
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

export async function usdTokenAmount(token: Address, amount: string, weth: Address, quoter: Address) {
  const raw = await tokenAmount(token, zeroAddress, amount, "usd", { weth, quoter, fee: 10_000 });
  const { decimals } = await tokenMetadata(token);
  return { raw: raw.toString(), display: formatUnits(raw, decimals) };
}

type V4PoolKey = IndexedV4PoolKey;

async function quoteV4Pool(poolKey: V4PoolKey, zeroForOne: boolean, amountIn: bigint, quoter: Address) {
  try {
    const quote = await rpcClient().simulateContract({
      address: quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return quote.result[0] > 0n ? quote.result[0] : undefined;
  } catch {
    return undefined;
  }
}

async function bestIndexedV4Quote(poolKeys: V4PoolKey[], zeroForOne: boolean, amountIn: bigint, quoter: Address) {
  const candidates = await Promise.all(poolKeys.map(async (poolKey) => ({
    poolKey,
    amountOut: await quoteV4Pool(poolKey, zeroForOne, amountIn, quoter),
  })));
  return candidates.reduce<{ poolKey: V4PoolKey; amountOut: bigint } | undefined>((best, candidate) =>
    candidate.amountOut !== undefined && (!best || candidate.amountOut > best.amountOut)
      ? { poolKey: candidate.poolKey, amountOut: candidate.amountOut }
      : best, undefined);
}

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

async function prepareIndexedNativeV4Buy(
  request: ExecutionRequest,
  owner: Address,
  token: Address,
  poolKey: V4PoolKey,
  amountIn: bigint,
  slippageBps: number,
  infrastructure: { quoter: Address; router: Address },
) {
  const amountOut = await quoteV4Pool(poolKey, true, amountIn, infrastructure.quoter);
  if (!amountOut) throw new Error("quote returned no output");
  const minimum = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  const v4Input = encodeV4ExactInput(poolKey, true, amountIn, minimum);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x10", [v4Input], deadline] });
  return {
    ...(await prepareSigned(request, infrastructure.router, data, amountIn)),
    ...(await tradeOutputSnapshot(owner, token)),
    involvedPairTokenAddress: zeroAddress,
  };
}

async function prepareIndexedNativeV4Sell(
  request: ExecutionRequest,
  owner: Address,
  token: Address,
  poolKey: V4PoolKey,
  amount: bigint,
  slippageBps: number,
  infrastructure: { quoter: Address; router: Address; permit2: Address },
) {
  const client = rpcClient();
  const allowance = await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [owner, infrastructure.permit2] });
  if (allowance < amount) return prepareApproval(request, token, infrastructure.permit2, amount, "v4p2");
  const amountOut = await quoteV4Pool(poolKey, false, amount, infrastructure.quoter);
  if (!amountOut) throw new Error("quote returned no output");
  const minimum = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  const [, , nonce] = await client.readContract({ address: infrastructure.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, infrastructure.router] });
  const now = Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 10 * 60);
  const permit = {
    details: { token, amount, expiration: now + 30 * 24 * 60 * 60, nonce },
    spender: infrastructure.router,
    sigDeadline: deadline,
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
  const v4Input = encodeV4ExactInput(poolKey, false, amount, minimum);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x0a10", [permitInput, v4Input], deadline] });
  return {
    ...(await prepareSigned(request, infrastructure.router, data, 0n)),
    ...(await tradeOutputSnapshot(owner, zeroAddress)),
    involvedPairTokenAddress: zeroAddress,
  };
}

async function bestV3Route(tokenIn: Address, tokenOut: Address, quoter: Address, amountIn: bigint) {
  const cacheKey = walletExecutionCacheKey("v3_route", tokenIn, tokenOut);
  const memory = routeCache.get(cacheKey);
  let cachedPath = memory && memory.expiresAt > Date.now() ? memory.path : undefined;
  if (!cachedPath) {
    const shared = await sharedWalletExecutionCache<{ path?: unknown }>(cacheKey, "v3_route");
    if (typeof shared?.path === "string" && /^0x(?:[a-fA-F0-9]{2})+$/.test(shared.path) && shared.path.length <= 512) {
      cachedPath = shared.path as Hex;
      routeCache.set(cacheKey, { path: cachedPath, expiresAt: Date.now() + ROUTE_MEMORY_CACHE_MS });
    }
  }
  // A cached path is a route hint, never a cached quote. Re-quote it against
  // current chain state for every transaction and only skip discovery when it
  // still returns a live positive output.
  let cachedFailure: string | undefined;
  if (cachedPath) {
    const cachedAttempt = await quoteV3Path(cachedPath, quoter, amountIn);
    if (cachedAttempt.quote) return cachedAttempt.quote;
    cachedFailure = cachedAttempt.failure;
    routeCache.delete(cacheKey);
  }

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
  const uniqueCandidates = [...new Set(candidates)].filter((path) => path !== cachedPath);
  const quoted: Array<{ quote?: { path: Hex; amountOut: bigint }; failure?: string }> = [];
  for (let offset = 0; offset < uniqueCandidates.length; offset += 5) {
    quoted.push(...await Promise.all(uniqueCandidates.slice(offset, offset + 5).map((path) => quoteV3Path(path, quoter, amountIn))));
  }
  const best = quoted.flatMap(item => item.quote ? [item.quote] : [])
    .reduce<{ path: Hex; amountOut: bigint } | undefined>((current, item) => !current || item.amountOut > current.amountOut ? item : current, undefined);
  if (!best) {
    const failures = quoted.reduce<Record<string, number>>((counts, item) => {
      const reason = item.failure || "unknown";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    const direct = uniqueCandidates.filter(path => path.length === 88).length;
    const detail = [
      "V3_ROUTE_NO_QUOTE",
      `token_in=${tokenIn.toLowerCase()}`,
      `token_out=${tokenOut.toLowerCase()}`,
      `amount_in=${amountIn}`,
      `candidates=${uniqueCandidates.length}`,
      `direct=${direct}`,
      `via_usdg=${Math.max(0, uniqueCandidates.length - direct)}`,
      `failures=${Object.entries(failures).sort().map(([reason, count]) => `${reason}:${count}`).join(",") || "none"}`,
      ...(cachedFailure ? [`cached_route=${cachedFailure}`] : []),
    ].join(" ");
    throw new Error(detail);
  }
  routeCache.set(cacheKey, { path: best.path, expiresAt: Date.now() + ROUTE_MEMORY_CACHE_MS });
  await rememberWalletExecutionCache(cacheKey, "v3_route", { path: best.path }, ROUTE_SHARED_CACHE_MS);
  return best;
}

async function quoteV3Path(path: Hex, quoter: Address, amountIn: bigint) {
  try {
    const result = await rpcClient().simulateContract({
      address: quoter, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn],
    });
    return result.result[0] > 0n
      ? { quote: { path, amountOut: result.result[0] } }
      : { failure: "zero_output" };
  } catch (error) {
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    const failure = /timeout|timed out|abort/i.test(message) ? "rpc_timeout"
      : /429|rate.?limit|too many requests/i.test(message) ? "rpc_rate_limited"
        : /revert/i.test(message) ? "quote_reverted"
          : /network|fetch|transport|socket/i.test(message) ? "rpc_transport"
            : "quote_call_failed";
    return { failure };
  }
}

async function inputForTokenTarget(target: bigint, seed: bigint, quote: (amountIn: bigint) => Promise<bigint>) {
  if (target <= 0n) throw new Error("token quantity must be positive");
  let input = seed > 0n ? seed : 1n;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const output = await quote(input);
    if (output <= 0n) throw new Error("token quantity quote returned no output");
    if (output >= target) return input * 10_300n / 10_000n + 1n;
    input = input * target / output * 10_050n / 10_000n + 1n;
  }
  throw new Error("could not quote the requested token quantity");
}

/** Read-only route construction for a confirmed LP funding plan. No CDP calls.
 * All output is delivered to the same owner. Only the USDG conversion helper
 * below may sell an ERC-20, and it rejects USDG when USDG is the position token.
 */
export async function quoteLiquidityPurchase(owner: Address, token: Address, minimumTokens: bigint, slippageBps: number, depth = 0, deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)): Promise<{ nativeInput: bigint; calls: LiquidityTransaction[] }> {
  if (depth > 2 || minimumTokens <= 0n) throw new Error("Invalid liquidity funding route");
  const client = rpcClient(), weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address;
  const quoter = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address;
  const router = "0xcaf681a66d020601342297493863e78c959e5cb2" as Address;
  const universal = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
  const v4quoter = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address;
  const factory = (process.env.PONS_V2_FACTORY_ADDRESS || "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as Address;
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address;
  const call = (to: Address, data: Hex, value = 0n, purpose = "funding_buy"): LiquidityTransaction => ({ to, data, value: value.toString(), purpose });
  const inputFor = async (quote: (amount: bigint) => Promise<bigint>, seed: bigint) => {
    const target = (minimumTokens * BigInt(10000 + slippageBps) + 9999n) / 10000n;
    let low = 0n;
    let high = seed > 0n ? seed : 1n;
    let out = await quote(high);
    if (out <= 0n) throw new Error("No usable liquidity funding quote");

    // A proportional estimate approaches a constant-product target from
    // below as price impact grows. Bracket the target with a small overshoot
    // instead of giving up after a fixed number of under-target estimates.
    for (let attempt = 0; out < target && attempt < 20; attempt++) {
      low = high;
      const proportional = (high * target + out - 1n) / out;
      high = proportional * 10_500n / 10_000n + 1n;
      if (high <= low) high = low * 2n;
      out = await quote(high);
      if (out <= 0n) throw new Error("No usable liquidity funding quote");
    }
    if (out < target) throw new Error("No usable liquidity funding quote");

    // Keep the funded maximum close to the requested output while retaining
    // the slippage cushion already included in target.
    for (let attempt = 0; attempt < 12 && high - low > 1n; attempt++) {
      const middle = (low + high) / 2n;
      const middleOut = await quote(middle);
      if (middleOut <= 0n) throw new Error("No usable liquidity funding quote");
      if (middleOut >= target) high = middle;
      else low = middle;
    }
    return high;
  };
  if (token.toLowerCase() === weth) return { nativeInput: minimumTokens, calls: [call(weth, encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" }), minimumTokens, "funding_wrap")] };
  const launched = await resolveActivePonsCurve(token, factory, true);
  if (launched) {
    const pair = launched.pairToken;
    let key: V4PoolKey | undefined;
    if (launched.phase === 2) {
      const hook = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" });
      const order = [pair.toLowerCase(), token.toLowerCase()].sort() as [Address, Address];
      key = { currency0: order[0], currency1: order[1], fee: launched.poolFee, tickSpacing: launched.tickSpacing, hooks: hook };
    }
    const curveReadAbi = parseAbi(["function getReserves() view returns(uint256,uint256)", "function feeBps() view returns(uint256)"]);
    const curve = launched.phase === 0 ? await Promise.all([
      client.readContract({ address: launched.curve, abi: curveReadAbi, functionName: "getReserves" }),
      client.readContract({ address: launched.curve, abi: curveReadAbi, functionName: "feeBps" }),
    ]) : undefined;
    if (!key && !curve) throw new Error("Token is migrating; request a fresh liquidity quote shortly");
    const pairDecimals = pair === zeroAddress ? 18 : (await tokenMetadata(pair)).decimals;
    const pairInput = await inputFor(async amount => {
      if (curve) {
        const [[quoteReserve, tokenReserve], fee] = curve;
        if (fee >= 10000n) throw new Error("Invalid bonding curve fee");
        const net = amount * (10000n - fee) / 10000n;
        return tokenReserve * net / (quoteReserve + net);
      }
      return await quoteV4Pool(key!, key!.currency0 === pair.toLowerCase(), amount, v4quoter) || 0n;
    }, 10n ** BigInt(Math.max(0, pairDecimals - 6)));
    const calls: LiquidityTransaction[] = [];
    let nativeInput = pairInput;
    if (pair !== zeroAddress) {
      if (pair.toLowerCase() === token.toLowerCase()) throw new Error("Invalid self-paired funding route");
      // Purchase a dedicated amount for this trade rather than draining an
      // existing paired-asset holding which may be reserved for the LP itself.
      const purchase = await quoteLiquidityPurchase(owner, pair, pairInput, slippageBps, depth + 1, deadline);
      nativeInput = purchase.nativeInput; calls.push(...purchase.calls);
      const spender = curve ? launched.curve : permit2;
      const allowance = await client.readContract({ address: pair, abi: tokenAbi, functionName: "allowance", args: [owner, spender] });
      if (allowance > 0n && allowance < pairInput) calls.push(call(pair, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, 0n] }), 0n, "funding_approval_reset"));
      if (allowance < pairInput) calls.push(call(pair, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, pairInput] }), 0n, "funding_approval"));
      if (!curve) calls.push(call(permit2, encodeFunctionData({ abi: parseAbi(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]), functionName: "approve", args: [pair, universal, pairInput, Number(deadline)] }), 0n, "funding_permit2"));
    }
    if (curve) calls.push(call(launched.curve, encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [pairInput, minimumTokens, owner] }), pair === zeroAddress ? pairInput : 0n));
    else calls.push(call(universal, encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x10", [encodeV4ExactInput(key!, key!.currency0 === pair.toLowerCase(), pairInput, minimumTokens)], deadline] }), pair === zeroAddress ? pairInput : 0n));
    return { nativeInput, calls };
  }
  const indexed = indexedNativeV4Pools(token);
  if (indexed.length) {
    const value = await inputFor(async amount => (await bestIndexedV4Quote(indexed, true, amount, v4quoter))?.amountOut || 0n, 1_000_000_000_000n);
    const route = await bestIndexedV4Quote(indexed, true, value, v4quoter); if (!route) throw new Error("No usable liquidity funding quote");
    return { nativeInput: value, calls: [call(universal, encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x10", [encodeV4ExactInput(route.poolKey, true, value, minimumTokens)], deadline] }), value)] };
  }
  const value = await inputFor(async amount => (await bestV3Route(weth, token, quoter, amount)).amountOut, 1_000_000_000_000n);
  const route = await bestV3Route(weth, token, quoter, value);
  return { nativeInput: value, calls: [call(router, encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: route.path, recipient: owner, amountIn: value, amountOutMinimum: minimumTokens }] }), value)] };
}

export async function quoteLiquidityUsdgToEth(owner: Address, protectedToken: Address, minimumEth: bigint, maximumUsdg: bigint, slippageBps: number): Promise<{ usdgInput: bigint; calls: LiquidityTransaction[] }> {
  if (protectedToken.toLowerCase() === USDG) throw new Error("LP_INSUFFICIENT_FUNDING:the position token cannot be sold for funding");
  if (minimumEth <= 0n || maximumUsdg <= 0n) throw new Error("LP_INSUFFICIENT_FUNDING:not enough spare USDG");
  const router = "0xcaf681a66d020601342297493863e78c959e5cb2" as Address;
  const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address;
  const quoter = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address;
  const target = (minimumEth * BigInt(10000 + slippageBps) + 9999n) / 10000n;
  let input = maximumUsdg < 1000n ? maximumUsdg : 1000n;
  for (let i = 0; i < 10; i++) {
    if (input > maximumUsdg) throw new Error("LP_INSUFFICIENT_FUNDING:not enough ETH or spare USDG");
    const route = await bestV3Route(USDG as Address, weth, quoter, input);
    if (route.amountOut <= 0n) throw new Error("No usable USDG funding quote");
    if (route.amountOut >= target) {
      const calls: LiquidityTransaction[] = [];
      const allowance = await rpcClient().readContract({ address: USDG as Address, abi: tokenAbi, functionName: "allowance", args: [owner, router] });
      if (allowance > 0n && allowance < input) calls.push({ to: USDG as Address, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [router, 0n] }), value: "0", purpose: "funding_approval_reset" });
      if (allowance < input) calls.push({ to: USDG as Address, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [router, input] }), value: "0", purpose: "funding_approval" });
      const swap = encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: route.path, recipient: router, amountIn: input, amountOutMinimum: minimumEth }] });
      const unwrap = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minimumEth, owner] });
      calls.push({ to: router, data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [[swap, unwrap]] }), value: "0", purpose: "funding_usdg_to_eth" });
      return { usdgInput: input, calls };
    }
    input = (input * target + route.amountOut - 1n) / route.amountOut + 1n;
  }
  throw new Error("No usable USDG funding quote");
}

type TokenValueRoute = {
  weth: Address; quoter: Address; fee: number; factory?: Address; v4Quoter?: Address;
};

/** Value existing holdings using read-only quotes. Never simulate a funded buy
 * from the owner: transferring tokens only needs token holdings plus gas, not
 * the quoted amount of ETH or paired assets. No approvals or swaps are made. */
async function tokensForEthValue(token: Address, ethAmount: bigint, route: TokenValueRoute, visited: string[] = []): Promise<bigint> {
  const key = token.toLowerCase();
  if (visited.includes(key) || visited.length >= 3) throw new Error("invalid token valuation route");
  if (key === route.weth.toLowerCase()) return ethAmount;
  const launched = route.factory ? await resolveActivePonsCurve(token, route.factory) : undefined;
  if (launched) {
    const pair = launched.pairToken;
    const pairAmount = pair === zeroAddress ? ethAmount
      : await tokensForEthValue(pair, ethAmount, route, [...visited, key]);
    if (launched.phase === 0) {
      const abi = parseAbi(["function getReserves() view returns(uint256,uint256)", "function feeBps() view returns(uint256)"]);
      const [[quoteReserve, tokenReserve], fee] = await Promise.all([
        rpcClient().readContract({ address: launched.curve, abi, functionName: "getReserves" }),
        rpcClient().readContract({ address: launched.curve, abi, functionName: "feeBps" }),
      ]);
      if (fee >= 10000n || quoteReserve <= 0n || tokenReserve <= 0n) throw new Error("invalid bonding curve valuation");
      const net = pairAmount * (10000n - fee) / 10000n;
      return tokenReserve * net / (quoteReserve + net);
    }
    if (launched.phase !== 2) throw new Error("this Pons V2 token is still finalizing its Uniswap V4 pool");
    if (!route.v4Quoter) throw new Error("V4 valuation quoter is missing");
    const hook = await rpcClient().readContract({ address: route.factory!, abi: ponsFactoryAbi, functionName: "memeHook" });
    const pairFirst = BigInt(pair) < BigInt(token);
    const poolKey = { currency0: pairFirst ? pair : token, currency1: pairFirst ? token : pair, fee: launched.poolFee, tickSpacing: launched.tickSpacing, hooks: hook };
    const quoted = await quoteV4Pool(poolKey, pairFirst, pairAmount, route.v4Quoter);
    if (!quoted) throw new Error("no usable token valuation route");
    return quoted;
  }
  const indexed = indexedNativeV4Pools(token);
  if (indexed.length && route.v4Quoter) {
    const quoted = await bestIndexedV4Quote(indexed, true, ethAmount, route.v4Quoter);
    if (!quoted) throw new Error("no usable token valuation route");
    return quoted.amountOut;
  }
  return (await bestV3Route(route.weth, token, route.quoter, ethAmount)).amountOut;
}

async function tokenAmount(address: Address, owner: Address, amount: string, unit: string, swap?: TokenValueRoute) {
  const client = rpcClient();
  const { decimals } = await tokenMetadata(address);
  if (unit === "token") return parseUnits(amount, decimals);
  if (unit === "percent") {
    const balance = await client.readContract({ address, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    return balance * BigInt(Math.round(Number(amount) * 100)) / 10_000n;
  }
  if ((unit === "usd" || unit === "eth") && swap) {
    const ethAmount = unit === "usd" ? await checkedUsdToEthWei(amount) : parseEther(amount);
    return tokensForEthValue(address, ethAmount, swap);
  }
  throw new Error("unsupported token amount unit");
}

async function ponsDenominatedSellTokenAmount(token: Address, owner: Address, amount: string, unit: "usd" | "eth", launched: {
  curve: Address; pairToken: Address; phase: number; poolFee: number; tickSpacing: number;
}, factory: Address, infrastructure: { weth: Address; v3Quoter: Address; v4Quoter: Address }) {
  const client = rpcClient();
  const ethAmount = unit === "usd" ? await checkedUsdToEthWei(amount) : parseEther(amount);
  const quoteAmount = launched.pairToken === zeroAddress
    ? ethAmount
    : (await bestV3Route(infrastructure.weth, launched.pairToken, infrastructure.v3Quoter, ethAmount)).amountOut;
  if (launched.phase === 0) {
    const quote = await client.simulateContract({
      account: owner, address: launched.curve, abi: ponsCurveAbi, functionName: "buy",
      args: [quoteAmount, 0n, owner], value: launched.pairToken === zeroAddress ? quoteAmount : 0n,
    });
    if (quote.result <= 0n) throw new Error("USD sell amount resolved to zero tokens");
    return quote.result;
  }
  if (launched.phase !== 2) throw new Error("this Pons V2 token is still finalizing its Uniswap V4 pool");
  const hook = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" });
  const tokenIsCurrency0 = BigInt(token) < BigInt(launched.pairToken);
  const poolKey = { currency0: tokenIsCurrency0 ? token : launched.pairToken, currency1: tokenIsCurrency0 ? launched.pairToken : token, fee: launched.poolFee, tickSpacing: launched.tickSpacing, hooks: hook };
  const quote = await client.simulateContract({ address: infrastructure.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne: !tokenIsCurrency0, exactAmount: quoteAmount, hookData: "0x" }] });
  if (quote.result[0] <= 0n) throw new Error("USD sell amount resolved to zero tokens");
  return quote.result[0];
}

type TransactionGasQuote = { estimatedGas: bigint; fees: Awaited<ReturnType<typeof estimateActualFees>> };

async function ethTransferValue(owner: Address, recipient: Address, amount: string, unit: "eth" | "usd" | "percent") {
  const client = rpcClient();
  const requested = unit === "usd" ? await checkedUsdToEthWei(amount)
    : unit === "eth" ? parseEther(amount)
      : await client.getBalance({ address: owner }) * BigInt(Math.round(Number(amount) * 100)) / 10_000n;
  const [balance, fees] = await Promise.all([client.getBalance({ address: owner }), estimateActualFees(client)]);
  const gas = await client.estimateGas({
    account: owner, to: recipient, value: requested > 0n ? requested : 1n,
    // Estimation only: a full-balance request cannot cover gas until we have
    // calculated the reserve. Never assume 21,000 for a contract recipient.
    stateOverride: [{ address: owner, balance: balance + requested + parseEther("1") }],
  });
  // Match the same single 10% gas budget used for signing; no extra cushion.
  const gasReserve = sendAllGasReserve(gas, fees.maxFeePerGas);
  if (balance <= gasReserve) throw insufficientGasError(gas, fees.maxFeePerGas);
  const maximumTransfer = balance - gasReserve;
  if (unit !== "percent" && requested > maximumTransfer) throw new Error("ETH transfer amount plus gas exceeds wallet balance");
  const value = unit === "percent" && requested > maximumTransfer ? maximumTransfer : requested;
  if (value <= 0n) throw new Error("ETH transfer amount resolves to zero after reserving gas");
  return { value, gasQuote: { estimatedGas: gas, fees } satisfies TransactionGasQuote };
}

async function prepareUnsignedWithAccount(request: Omit<ExecutionRequest, "operation">, to: Address, data: Hex, value: bigint, minimumBlock?: bigint, gasQuote?: TransactionGasQuote, launchFee?: bigint) {
  const client = rpcClient();
  if (await client.getChainId() !== ROBINHOOD_CHAIN_ID) throw new Error("RPC chain mismatch");
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  if (account.address.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("wallet owner mismatch");
  if (minimumBlock !== undefined && await client.getBlockNumber({ cacheTime: 0 }) < minimumBlock) throw new Error("LP_RPC_BEHIND_CONFIRMED_STEP");
  // Simulation-only funding lets an empty wallet produce a real execution and
  // gas estimate. It does not alter chain state or weaken the real-balance
  // check immediately before signing.
  const simulationBalance = value + parseEther("100");
  const stateOverride = [{ address: account.address, balance: simulationBalance }];
  await client.call({ account: account.address, to, data, value, stateOverride });
  const [firstGas, firstFees, rpcNonce, balance] = await Promise.all([
    gasQuote?.estimatedGas ?? client.estimateGas({ account: account.address, to, data, value, stateOverride }),
    gasQuote?.fees ?? estimateActualFees(client),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.getBalance({ address: account.address }),
  ]);
  const { estimatedGas, fees } = await recheckLaunchGas({ estimatedGas: firstGas, fees: firstFees }, launchFee, async () => {
    const [estimatedGas, fees] = await Promise.all([
      client.estimateGas({ account: account.address, to, data, value, stateOverride }),
      estimateActualFees(client),
    ]);
    return { estimatedGas, fees };
  });
  const nonce = Math.max(rpcNonce, request.minimumNonce || 0);
  const gasEnvelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  // Nodes require the sender to cover value plus the transaction's maximum
  // EIP-1559 gas liability, not merely the current expected gas charge. Check
  // the exact buffered envelope before CDP signs so an underfunded request
  // fails immediately with an actionable response instead of timing out while
  // waiting for a transaction that could never enter the mempool.
  if (balance < transactionMaximumCost(value, estimatedGas, fees.maxFeePerGas)) {
    throw insufficientGasError(estimatedGas, fees.maxFeePerGas, "transaction total cost (gas * gas fee + value) exceeds the balance");
  }
  const transaction = {
    chainId: ROBINHOOD_CHAIN_ID, type: "eip1559" as const, to, data, value, nonce,
    gas: gasEnvelope.gas,
    // Base fees can rise between simulation, CDP signing, and serverless
    // broadcast. Keep headroom so a valid prepared transaction is not rejected
    // before it reaches the mempool during a short fee spike.
    maxFeePerGas: gasEnvelope.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  return {
    envelope: { unsignedTransaction: serializeTransaction(transaction), toAddress: to, valueWei: value.toString(), nonce },
    accountAddress: account.address,
  };
}

export async function prepareUnsigned(request: Omit<ExecutionRequest, "operation">, to: Address, data: Hex, value: bigint, minimumBlock?: bigint) {
  // Keep the persisted LP envelope format unchanged. Account identity is only
  // passed internally for immediate signing, never trusted from an envelope.
  return (await prepareUnsignedWithAccount(request, to, data, value, minimumBlock)).envelope;
}

export async function signPreparedEnvelope(request: Omit<ExecutionRequest, "operation">, envelope: Awaited<ReturnType<typeof prepareUnsigned>>) {
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  if (account.address.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("wallet owner mismatch");
  const { signature } = await cdp().evm.signTransaction({ address: account.address, transaction: envelope.unsignedTransaction, idempotencyKey: request.idempotencyKey });
  return {
    transactionHash: keccak256(signature), status: "prepared" as const, toAddress: envelope.toAddress,
    signedTransaction: signature, valueWei: envelope.valueWei, nonce: envelope.nonce,
  };
}
export async function prepareSigned(request: Omit<ExecutionRequest, "operation">, to: Address, data: Hex, value: bigint, gasQuote?: TransactionGasQuote, launchFee?: bigint) {
  // CDP's account endpoint is case-sensitive. Reuse its exact verified address,
  // not a lowercased request address, without doing a second account lookup.
  // ETH sends reserve and sign with the same fresh quote, instead of making
  // a second estimate that can consume the entire send-all balance cushion.
  const { envelope, accountAddress } = await prepareUnsignedWithAccount(request, to, data, value, undefined, gasQuote, launchFee);
  const { signature } = await cdp().evm.signTransaction({ address: accountAddress, transaction: envelope.unsignedTransaction, idempotencyKey: request.idempotencyKey });
  return { transactionHash: keccak256(signature), status: "prepared" as const, toAddress: to, signedTransaction: signature, valueWei: value.toString(), nonce: envelope.nonce };
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

export async function tokenValueAtBlock(token: Address, amount: string, blockNumberText: string) {
  const blockNumber = BigInt(blockNumberText);
  const client = rpcClient();
  const [marketCapUsd, totalSupply, decimals] = await Promise.all([
    tokenMarketCapUsd(token, blockNumber),
    client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply", blockNumber }),
    client.readContract({ address: token, abi: tokenAbi, functionName: "decimals", blockNumber }),
  ]);
  const supply = Number(formatUnits(totalSupply, decimals));
  const tokenAmount = Number(amount);
  if (marketCapUsd === undefined || !Number.isFinite(supply) || supply <= 0
    || !Number.isFinite(tokenAmount) || tokenAmount <= 0) throw new Error("purchase-time token value is unavailable");
  const usdValue = tokenAmount * marketCapUsd / supply;
  if (!Number.isFinite(usdValue) || usdValue < 0) throw new Error("purchase-time token value is invalid");
  return { usdValue, marketCapUsd, blockNumber: blockNumberText };
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

async function vanityLaunchSalt(
  client: ReturnType<typeof rpcClient>, request: ExecutionRequest,
  operation: Extract<ExecutionRequest["operation"], { type: "pons_v2_launch" | "pons_v2_launch_and_buy" }>,
  factory: Address, owner: Address, pairToken: Address,
) {
  const configId = BigInt(operation.launchConfigId);
  const [config, feeEscrow, buybackVault, deployer, memeHook] = await Promise.all([
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "getLaunchConfig", args: [configId] }),
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "feeEscrow" }),
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "buybackVault" }),
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "launchDeployer" }),
    client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "memeHook" }),
  ]);
  const policy = await client.readContract({ address: memeHook, abi: ponsMemeHookPolicyAbi, functionName: "currentFeePolicy" });
  const pairEconomics = pairToken === zeroAddress ? undefined : await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "pairTokenEconomics", args: [pairToken] });
  const baseSalt = launchSalt(request);
  const creatorFeeRecipient = operation.creatorFeeRecipient as Address;
  const base = {
    pairToken, creatorFeeRecipient, originalDeployer: owner, feePolicy: memeHook, policy,
    feeEscrow, buybackVault,
    phantomQuote: pairEconomics?.phantomQuote || config.phantomQuote,
    curveFeeBps: config.curveFeeBps, creatorTaxBps: 0n, buybackEnabled: false,
    graduationThreshold: pairEconomics?.graduationThreshold || config.graduationThreshold, supply: config.supply,
    name: operation.name, symbol: operation.symbol, logo: operation.imageUri, description: operation.description,
    socials: { twitter: operation.socials.twitter, telegram: operation.socials.telegram, discord: "", website: operation.socials.website, farcaster: "" },
  } as const;
  if (operation.preparedSalt && operation.predictedTokenAddress && operation.predictedCurveAddress) {
    const [tokenAddress, curveAddress] = await client.readContract({
      address: deployer, abi: ponsLaunchDeployerAbi, functionName: "predictLaunchAddresses",
      args: [{ ...base, salt: operation.preparedSalt as Hex }],
    });
    if (tokenAddress.toLowerCase() !== operation.predictedTokenAddress.toLowerCase()
      || curveAddress.toLowerCase() !== operation.predictedCurveAddress.toLowerCase()
      || !tokenAddress.toLowerCase().endsWith("b07")) throw new Error("persisted Pons b07 prediction is invalid");
    return { salt: operation.preparedSalt as Hex, tokenAddress, curveAddress };
  }
  // Address prediction hashes two large creation-code payloads. Keep each on-chain
  // multicall below ordinary RPC execution/gas limits while still amortizing requests.
  const batchSize = 24;
  for (let offset = 0; offset < 100_000; offset += batchSize) {
    const candidates = Array.from({ length: Math.min(batchSize, 100_000 - offset) }, (_, index) => {
      const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [baseSalt, BigInt(offset + index)]));
      return { salt, contract: { address: deployer, abi: ponsLaunchDeployerAbi, functionName: "predictLaunchAddresses" as const, args: [{ ...base, salt }] } };
    });
    const results = await client.multicall({ contracts: candidates.map((candidate) => candidate.contract), allowFailure: true, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11" });
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status !== "success") continue;
      const [tokenAddress, curveAddress] = result.result;
      if (tokenAddress.toLowerCase().endsWith("b07")) return { salt: candidates[index].salt, tokenAddress, curveAddress };
    }
  }
  throw new Error("could not find a Pons Bot b07 contract address");
}

export async function prepareLaunchAddresses(request: ExecutionRequest) {
  const operation = request.operation;
  if (!operation || (operation.type !== "pons_v2_launch" && operation.type !== "pons_v2_launch_and_buy")) throw new Error("launch operation required");
  const prediction = await vanityLaunchSalt(rpcClient(), request, operation, operation.factoryAddress as Address, request.expectedFrom as Address, operation.pairToken as Address);
  return { preparedSalt: prediction.salt, predictedTokenAddress: prediction.tokenAddress, predictedCurveAddress: prediction.curveAddress };
}

export async function holderDistributorInfo(token: Address, distributorFactoryAddress: Address, ponsFactoryAddress: Address) {
  const [distributor, launched] = await Promise.all([
    rpcClient().readContract({ address: distributorFactoryAddress, abi: holderDistributorFactoryAbi, functionName: "distributorOf", args: [token] }),
    rpcClient().readContract({ address: ponsFactoryAddress, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token] }),
  ]);
  return {
    distributor: distributor === zeroAddress ? null : distributor,
    creatorFeeRecipient: launched.exists ? launched.creatorFeeRecipient : null,
    pairToken: launched.exists ? launched.pairToken : null,
    deployer: launched.exists ? launched.deployer : null,
    exists: launched.exists,
  };
}

export async function feeClaimPlan(
  tokenAddresses: Address[],
  owner: Address,
  factory: Address,
  specificTokenAddress?: Address,
  includeClaimableState = false,
) {
  const unique = [...new Set(tokenAddresses.map((token) => token.toLowerCase()))] as Address[];
  const eligible: Address[] = [];
  const client = rpcClient();
  // Recipient authority is mutable through fee reassignment. Always read it
  // live here; only immutable routing metadata is eligible for caching.
  for (let offset = 0; offset < unique.length; offset += 8) {
    const batch = unique.slice(offset, offset + 8);
    const results = await Promise.allSettled(
      batch.map(async (token) => {
        const launch = await resolveActivePonsCurve(token, factory, true);
        if (!launch || launch.creatorFeeRecipient.toLowerCase() !== owner.toLowerCase()) return undefined;
        if (!includeClaimableState || !specificTokenAddress) {
          if (launch.pairToken !== zeroAddress) return undefined;
        } else if (token.toLowerCase() !== specificTokenAddress.toLowerCase()) return undefined;
        return await curveSweepIsEmpty(client, launch.curve) ? undefined : launch;
      }),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled" || !result.value) continue;
      const launch = result.value;
      if (launch.creatorFeeRecipient.toLowerCase() === owner.toLowerCase()) eligible.push(batch[index]);
    }
  }
  if (!includeClaimableState) return { tokenAddresses: eligible };
  const escrow = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "feeEscrow" });
  let specificPairToken: Address | undefined;
  let escrowBalance: bigint;
  if (specificTokenAddress) {
    const launch = await resolveActivePonsCurve(specificTokenAddress, factory, true);
    if (!launch) throw new Error("no completed Pons launch was found for that token");
    specificPairToken = launch.pairToken;
    escrowBalance = launch.pairToken === zeroAddress
      ? await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [owner] })
      : await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOfToken", args: [owner, launch.pairToken] });
  } else {
    escrowBalance = await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [owner] });
  }
  return {
    tokenAddresses: eligible,
    hasClaimableFees: escrowBalance > 0n || eligible.length > 0,
    escrowBalance: escrowBalance.toString(),
    ...(specificPairToken ? { pairToken: specificPairToken } : {}),
  };
}

type PonsLaunchOperation = Extract<ExecutionRequest["operation"], {
  type: "pons_v2_launch" | "pons_v2_launch_and_buy";
}>;
type FreeLaunchFundingEstimate = {
  amountWei: string;
  launchFeeWei: string;
  estimatedGas: string;
  bufferedGasCostWei: string;
};
type PreparedPonsLaunch = Awaited<ReturnType<typeof prepareSigned>> & {
  tokenAddress?: Address;
  poolAddress?: Address;
  /** Native ETH spent on the opening developer buy, excluding the launch fee. */
  devBuyWei?: string;
  devBuySucceeded?: boolean;
  approvalRequired?: boolean;
  approvalTokenAddress?: Address;
};

function includeLaunchFeeInGasError(error: unknown, launchFee: bigint) {
  if (!(error instanceof Error)) return error;
  const match = error.message.match(/\[gas_estimate_wei=(\d+)\]/i);
  if (!match) return error;
  return new Error(error.message.replace(match[0], `[launch_cost_estimate_wei=${BigInt(match[1]) + launchFee}]`));
}

function preparePonsLaunch(request: ExecutionRequest, operation: PonsLaunchOperation): Promise<PreparedPonsLaunch>;
function preparePonsLaunch(request: ExecutionRequest, operation: PonsLaunchOperation, fundingEstimateOnly: true): Promise<FreeLaunchFundingEstimate>;
async function preparePonsLaunch(
  request: ExecutionRequest,
  operation: PonsLaunchOperation,
  fundingEstimateOnly = false,
): Promise<PreparedPonsLaunch | FreeLaunchFundingEstimate> {
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
  const vanity = await vanityLaunchSalt(client, request, operation, factory, owner, pairToken);
  const params = {
    name: operation.name, symbol: operation.symbol, logo: operation.imageUri, description: operation.description,
    socials: { twitter: operation.socials.twitter, telegram: operation.socials.telegram, discord: "", website: operation.socials.website, farcaster: "" },
    creatorFeeRecipient: operation.creatorFeeRecipient as Address, creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics, salt: vanity.salt,
  } as const;
  if (operation.type === "pons_v2_launch") {
    const simulation = await client.simulateContract({
      account: owner, address: factory, abi: ponsFactoryAbi, functionName: "launchToken",
      args: [params, launchConfigId, pairToken, []], value: launchFee,
      // Funding estimates commonly run for an empty wallet. The simulation
      // happens before eth_estimateGas, so it needs the same simulation-only
      // balance override or the RPC rejects the launch before sponsorship.
      stateOverride: [{ address: owner, balance: launchFee + parseEther("100") }],
    });
    const data = encodeFunctionData({ abi: ponsFactoryAbi, functionName: "launchToken", args: [params, launchConfigId, pairToken, []] });
    if (fundingEstimateOnly) {
      return estimateFreeLaunchGrant(client, owner, factory, data, launchFee, launchFee);
    }
    const prepared = await prepareSigned(request, factory, data, launchFee, undefined, launchFee)
      .catch(error => { throw includeLaunchFeeInGasError(error, launchFee); });
    if (simulation.result[0].toLowerCase() !== vanity.tokenAddress.toLowerCase() || simulation.result[1].toLowerCase() !== vanity.curveAddress.toLowerCase()) throw new Error("Pons expected launch address did not match the b07 prediction");
    return {
      ...prepared,
      tokenAddress: simulation.result[0],
      poolAddress: simulation.result[1],
      devBuyWei: "0",
      devBuySucceeded: false,
    };
  }
  if (!operation.devBuy) throw new Error("initial launch buy amount is missing");
  const nativePair = pairToken === zeroAddress;
  let quoteIn: bigint;
  if (nativePair) {
    if (operation.devBuy.unit === "pair") throw new Error("an ETH-paired developer buy must use ETH or USD");
    quoteIn = operation.devBuy.unit === "usd" ? await checkedUsdToEthWei(operation.devBuy.amount) : parseEther(operation.devBuy.amount);
  } else {
    if (operation.devBuy.unit === "eth") throw new Error("a non-ETH developer buy must use USD or an amount of the paired asset");
    const [metadata, allowance] = await Promise.all([
      tokenMetadata(pairToken),
      client.readContract({ address: pairToken, abi: tokenAbi, functionName: "allowance", args: [owner, router] }),
    ]);
    quoteIn = operation.devBuy.unit === "usd"
      ? (await bestV3Route(operation.wethAddress as Address, pairToken, operation.quoterAddress as Address, await checkedUsdToEthWei(operation.devBuy.amount))).amountOut
      : parseUnits(operation.devBuy.amount, metadata.decimals);
    if (allowance < quoteIn) {
      if (fundingEstimateOnly) throw new Error("paired asset approval is required before estimating launch sponsorship");
      return prepareApproval(request, pairToken, router, quoteIn, "pair-approval");
    }
  }
  const value = launchFee + (nativePair ? quoteIn : 0n);
  const first = await client.simulateContract({
    account: owner, address: router, abi: ponsRouterAbi, functionName: "launchAndBuy",
    args: [params, launchConfigId, pairToken, quoteIn, 0n, owner, []], value,
    stateOverride: [{ address: owner, balance: value + parseEther("100") }],
  });
  if (first.result[0].toLowerCase() !== vanity.tokenAddress.toLowerCase() || first.result[1].toLowerCase() !== vanity.curveAddress.toLowerCase()) throw new Error("Pons expected launch address did not match the b07 prediction");
  const minimum = first.result[2] * 9_750n / 10_000n;
  const data = encodeFunctionData({
    abi: ponsRouterAbi, functionName: "launchAndBuy",
    args: [params, launchConfigId, pairToken, quoteIn, minimum, owner, []],
  });
  if (fundingEstimateOnly) {
    return estimateFreeLaunchGrant(client, owner, router, data, value, launchFee);
  }
  const prepared = await prepareSigned(request, router, data, value, undefined, launchFee)
    .catch(error => { throw includeLaunchFeeInGasError(error, launchFee); });
  return {
    ...prepared,
    tokenAddress: first.result[0],
    poolAddress: first.result[1],
    // This field is deliberately ETH-denominated. A non-ETH paired-asset
    // opening buy is still represented by devBuySucceeded, but is not Wei.
    devBuyWei: nativePair ? quoteIn.toString() : "0",
    devBuySucceeded: true,
  };
}

async function estimateFreeLaunchGrant(
  client: ReturnType<typeof rpcClient>,
  owner: Address,
  to: Address,
  data: Hex,
  transactionValue: bigint,
  launchFee: bigint,
) {
  const [estimatedGas, fees] = await Promise.all([
    client.estimateGas({
      account: owner,
      to,
      data,
      value: transactionValue,
      // Free-launch candidates are commonly empty wallets. Supply simulation-
      // only balance so eth_estimateGas measures execution rather than
      // rejecting before sponsorship for insufficient sender funds.
      stateOverride: [{ address: owner, balance: parseEther("100") }],
    }),
    estimateActualFees(client),
  ]);
  const bufferedGasCost = sendAllGasReserve(estimatedGas, fees.maxFeePerGas);
  // ONE margin over the unbuffered launch fee + actual gas-price estimate.
  // Never buffer the already-buffered transaction envelope, and never fund
  // the developer buy included in transactionValue.
  const amountWei = sponsoredLaunchCost(launchFee, estimatedGas, fees.maxFeePerGas);
  if (amountWei <= 0n || amountWei > MAX_FREE_LAUNCH_GRANT_WEI) {
    throw new Error("estimated free launch grant is outside the permitted range");
  }
  return {
    amountWei: amountWei.toString(),
    launchFeeWei: launchFee.toString(),
    estimatedGas: estimatedGas.toString(),
    bufferedGasCostWei: bufferedGasCost.toString(),
  };
}

export async function freeLaunchFundingEstimate(request: ExecutionRequest) {
  await requireWalletNativeGas(request.expectedFrom);
  const operation = request.operation;
  if (operation.type !== "pons_v2_launch" && operation.type !== "pons_v2_launch_and_buy") {
    throw new Error("free launch funding estimate requires a launch operation");
  }
  const account = await cdp().evm.getOrCreateAccount({ name: accountName(request.ownerReference) });
  if (account.address.toLowerCase() !== request.expectedFrom.toLowerCase()) throw new Error("wallet owner mismatch");
  return preparePonsLaunch(request, operation, true);
}

export async function executeTransaction(request: ExecutionRequest) {
  const operation = request.operation;
  const nativeTargetError = nativeTokenOperationError(operation.type, "token" in operation ? operation.token : undefined);
  if (nativeTargetError) throw new Error(nativeTargetError);
  const owner = request.expectedFrom as Address;
  // Creator-fee reads must determine whether there is anything to claim or
  // sweep before asking the user to fund gas. These two branches perform the
  // same gas guard immediately before preparing a real transaction.
  if (operation.type !== "pons_v2_claim_fees"
    && operation.type !== "pons_v2_sweep_fees"
    && operation.type !== "pons_v2_launch"
    && operation.type !== "pons_v2_launch_and_buy")
    await requireWalletNativeGas(owner);
  if (operation.type === "erc20_burn_to_dead" && operation.deadAddress.toLowerCase() !== DEAD.toLowerCase()) {
    throw new Error("burn destination policy rejected the request");
  }
  if (operation.type === "eth_transfer") {
    const { value, gasQuote } = await ethTransferValue(owner, operation.recipient as Address, operation.amount, operation.unit);
    return prepareSigned(request, operation.recipient as Address, "0x", value, gasQuote);
  }
  if (operation.type === "erc20_transfer" || operation.type === "erc20_burn_to_dead") {
    const resolved = await resolveToken(operation.token);
    const recipient = operation.type === "erc20_transfer" ? operation.recipient : operation.deadAddress;
    const amount = await tokenAmount(resolved.address, owner, operation.amount, operation.unit, {
      weth: operation.wethAddress as Address, quoter: operation.quoterAddress as Address,
      fee: operation.fee,
      factory: operation.ponsFactoryAddress as Address | undefined,
      v4Quoter: operation.v4QuoterAddress as Address | undefined,
    });
    if (amount <= 0n) throw new Error("token amount resolved to zero");
    const balance = await rpcClient().readContract({ address: resolved.address, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    if (amount > balance) throw new Error("insufficient token balance");
    const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [recipient as Address, amount] });
    const burnSnapshot = operation.type === "erc20_burn_to_dead"
      ? await tradeOutputSnapshot(owner, resolved.address)
      : {};
    return { ...(await prepareSigned(request, resolved.address, data, 0n)), ...burnSnapshot };
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
      const desiredTokens = operation.unit === "token" ? parseUnits(operation.amount, resolved.decimals) : undefined;
      const ethValue = operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount)
        : operation.unit === "eth" ? parseEther(operation.amount) : 0n;
      let quoteIn = nativePair ? ethValue : operation.unit === "usd"
        ? (await bestV3Route(operation.wethAddress as Address, pons.pairToken, operation.quoterAddress as Address, ethValue)).amountOut
        : operation.unit === "pair" ? parseUnits(operation.amount, (await tokenMetadata(pons.pairToken)).decimals) : 0n;
      if (desiredTokens) {
        const pairDecimals = nativePair ? 18 : (await tokenMetadata(pons.pairToken)).decimals;
        const seed = 10n ** BigInt(Math.max(0, pairDecimals - 6));
        if (pons.phase === 0) {
          quoteIn = await inputForTokenTarget(desiredTokens, seed, async (amountIn) => {
            const simulated = await rpcClient().simulateContract({ account: owner, address: pons.curve, abi: ponsCurveAbi, functionName: "buy", args: [amountIn, 0n, owner], value: nativePair ? amountIn : 0n,
              stateOverride: [{ address: owner, balance: amountIn + parseEther("100") }] });
            return simulated.result;
          });
        } else if (pons.phase === 2) {
          const client = rpcClient();
          const hook = await client.readContract({ address: operation.ponsFactoryAddress as Address, abi: ponsFactoryAbi, functionName: "memeHook" });
          const tokenIsCurrency0 = BigInt(resolved.address) < BigInt(pons.pairToken);
          const poolKey = { currency0: tokenIsCurrency0 ? resolved.address : pons.pairToken, currency1: tokenIsCurrency0 ? pons.pairToken : resolved.address, fee: pons.poolFee, tickSpacing: pons.tickSpacing, hooks: hook };
          quoteIn = await inputForTokenTarget(desiredTokens, seed, async (amountIn) => {
            const quoted = await client.simulateContract({ address: configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress), abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne: !tokenIsCurrency0, exactAmount: amountIn, hookData: "0x" }] });
            return quoted.result[0];
          });
        }
      }
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
        stateOverride: [{ address: owner, balance: (nativePair ? quoteIn : 0n) + parseEther("100") }],
      });
      const minimum = simulation.result * BigInt(10_000 - operation.slippageBps) / 10_000n;
      const data = encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [quoteIn, minimum, owner] });
      return { ...(await prepareSigned(request, pons.curve, data, nativePair ? quoteIn : 0n)), ...(await tradeOutputSnapshot(owner, resolved.address)), involvedPairTokenAddress: pons.pairToken };
    }
    if (operation.unit === "pair") throw new Error("paired-asset amounts are only supported for Pons V2 tokens");
    const indexedV4Pools = indexedNativeV4Pools(resolved.address);
    if (indexedV4Pools.length) {
      const quoter = configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress);
      const value = operation.unit === "token"
        ? await inputForTokenTarget(parseUnits(operation.amount, resolved.decimals), 1_000_000_000_000n, async (amountIn) =>
          (await bestIndexedV4Quote(indexedV4Pools, true, amountIn, quoter))?.amountOut || 0n)
        : operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount) : parseEther(operation.amount);
      const route = await bestIndexedV4Quote(indexedV4Pools, true, value, quoter);
      if (!route) throw new Error("quote returned no output");
      return prepareIndexedNativeV4Buy(request, owner, resolved.address, route.poolKey, value, operation.slippageBps, {
        quoter,
        router: configuredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS", operation.universalRouterAddress),
      });
    }
    const value = operation.unit === "token"
      ? await inputForTokenTarget(parseUnits(operation.amount, resolved.decimals), 1_000_000_000_000n, async (amountIn) => (await bestV3Route(operation.wethAddress as Address, resolved.address, operation.quoterAddress as Address, amountIn)).amountOut)
      : operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount) : parseEther(operation.amount);
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
    const client = rpcClient();
    const pons = await resolveActivePonsCurve(resolved.address, operation.ponsFactoryAddress as Address);
    const indexedV4Pools = pons ? [] : indexedNativeV4Pools(resolved.address);
    const indexedV4Quoter = indexedV4Pools.length
      ? configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress)
      : undefined;
    const amount = (operation.unit === "usd" || operation.unit === "eth") && pons
      ? await ponsDenominatedSellTokenAmount(resolved.address, owner, operation.amount, operation.unit, pons, operation.ponsFactoryAddress as Address, {
        weth: operation.wethAddress as Address, v3Quoter: operation.quoterAddress as Address,
        v4Quoter: configuredAddress("PONS_V4_QUOTER_ADDRESS", operation.v4QuoterAddress),
      })
      : (operation.unit === "usd" || operation.unit === "eth") && indexedV4Pools.length && indexedV4Quoter
        ? await inputForTokenTarget(
          operation.unit === "usd" ? await checkedUsdToEthWei(operation.amount) : parseEther(operation.amount),
          10n ** BigInt(Math.max(0, resolved.decimals - 6)),
          async (amountIn) => (await bestIndexedV4Quote(indexedV4Pools, false, amountIn, indexedV4Quoter))?.amountOut || 0n,
        )
      : await tokenAmount(resolved.address, owner, operation.amount, operation.unit, {
        weth: operation.wethAddress as Address, quoter: operation.quoterAddress as Address, fee: operation.fee,
      });
    const balance = await client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    if (balance < amount) throw new Error("insufficient token balance for the requested sell amount");
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
    if (indexedV4Pools.length && indexedV4Quoter) {
      const route = await bestIndexedV4Quote(indexedV4Pools, false, amount, indexedV4Quoter);
      if (!route) throw new Error("quote returned no output");
      return prepareIndexedNativeV4Sell(request, owner, resolved.address, route.poolKey, amount, operation.slippageBps, {
        quoter: indexedV4Quoter,
        router: configuredAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS", operation.universalRouterAddress),
        permit2: configuredAddress("PONS_PERMIT2_ADDRESS", operation.permit2Address),
      });
    }
    const allowance = await client.readContract({ address: resolved.address, abi: tokenAbi, functionName: "allowance", args: [owner, operation.routerAddress as Address] });
    const quote = await bestV3Route(resolved.address, operation.wethAddress as Address, operation.quoterAddress as Address, amount);
    const minimum = quote.amountOut * BigInt(10_000 - operation.slippageBps) / 10_000n;
    const swapData = encodeFunctionData({
      abi: routerAbi, functionName: "exactInput",
      args: [{ path: quote.path, recipient: "0x0000000000000000000000000000000000000002", amountIn: amount, amountOutMinimum: minimum }],
    });
    const unwrapData = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minimum, owner] });
    const calls: Hex[] = [swapData, unwrapData];
    if (allowance < amount) return prepareApproval(request, resolved.address, operation.routerAddress as Address, amount, "router-approval");
    const data = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [calls] });
    return { ...(await prepareSigned(request, operation.routerAddress as Address, data, 0n)), ...(await tradeOutputSnapshot(owner, zeroAddress)) };
  }
  if (operation.type === "pons_v2_launch" || operation.type === "pons_v2_launch_and_buy") {
    return preparePonsLaunch(request, operation);
  }
  if (operation.type === "pons_v2_create_holder_distributor") {
    const factory = operation.distributorFactoryAddress as Address;
    const existing = await rpcClient().readContract({ address: factory, abi: holderDistributorFactoryAbi, functionName: "distributorOf", args: [operation.token as Address] });
    if (existing !== zeroAddress) throw new Error("holder fee distributor already exists");
    await rpcClient().simulateContract({ account: owner, address: factory, abi: holderDistributorFactoryAbi, functionName: "createFor", args: [operation.token as Address] });
    return prepareSigned(request, factory, encodeFunctionData({ abi: holderDistributorFactoryAbi, functionName: "createFor", args: [operation.token as Address] }), 0n);
  }
  if (operation.type === "pons_v2_transfer_creator_fee_recipient") {
    const factory = operation.factoryAddress as Address;
    const launched = await rpcClient().readContract({ address: factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [operation.token as Address] });
    if (!launched.exists || launched.creatorFeeRecipient.toLowerCase() !== owner.toLowerCase()) throw new Error("wallet is not the current creator fee recipient");
    await rpcClient().simulateContract({ account: owner, address: factory, abi: ponsFactoryAbi, functionName: "transferCreatorFeeRecipient", args: [operation.token as Address, operation.newRecipient as Address] });
    return prepareSigned(request, factory, encodeFunctionData({ abi: ponsFactoryAbi, functionName: "transferCreatorFeeRecipient", args: [operation.token as Address, operation.newRecipient as Address] }), 0n);
  }
  if (operation.type === "pons_v2_claim_fees") {
    const client = rpcClient();
    const factory = operation.factoryAddress as Address;
    const escrow = await client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: "feeEscrow" });
    let pairToken: Address = zeroAddress;
    if (operation.token) {
      const resolved = await resolveToken(operation.token);
      const launched = await resolveActivePonsCurve(resolved.address, factory, true);
      if (!launched) throw new Error("no completed Pons launch was found for that token");
      // Escrow balances are keyed to the claiming wallet and paired asset.
      // A former recipient may still withdraw amounts credited before rights
      // were reassigned, even though it may no longer sweep new curve fees.
      pairToken = launched.pairToken;
    }
    if (pairToken === zeroAddress) {
      const balance = await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOf", args: [owner] });
      if (balance === 0n) throw new Error("no claimable creator fees are available in ETH");
      await requireWalletNativeGas(owner);
      const data = encodeFunctionData({ abi: feeEscrowAbi, functionName: "claim" });
      return prepareSigned(request, escrow, data, 0n);
    }
    const balance = await client.readContract({ address: escrow, abi: feeEscrowAbi, functionName: "balanceOfToken", args: [owner, pairToken] });
    if (balance === 0n) throw new Error("no claimable creator fees are available in the paired asset");
    await requireWalletNativeGas(owner);
    const data = encodeFunctionData({ abi: feeEscrowAbi, functionName: "claimToken", args: [pairToken] });
    return prepareSigned(request, escrow, data, 0n);
  }
  if (operation.type === "pons_v2_sweep_fees") {
    const resolved = await resolveToken(operation.token);
    const factory = operation.factoryAddress as Address;
    const launched = await resolveActivePonsCurve(resolved.address, factory, true);
    if (!launched) throw new Error("no completed Pons launch was found for that token");
    if (launched.creatorFeeRecipient.toLowerCase() !== owner.toLowerCase()) throw new Error("wallet is not the launch creator fee beneficiary");
    // Also recheck specific-token claims and plans persisted before this guard.
    // The parent treats this as an unsubmitted no-op and still claims escrow.
    if (await curveSweepIsEmpty(rpcClient(), launched.curve)) throw new Error("nothing to sweep");
    await requireWalletNativeGas(owner);
    const data = encodeFunctionData({ abi: ponsCurveAbi, functionName: "sweepFees", args: [0n] });
    return prepareSigned(request, launched.curve, data, 0n);
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
  const primaryUrl = process.env.ROBINHOOD_RPC_URL || PUBLIC_ROBINHOOD_RPC_URL;
  const primaryClient = rpcClientFor(primaryUrl);
  let transactionHash: Hex | undefined;
  let primaryError: unknown;
  try {
    transactionHash = await submitSignedTransaction(primaryClient, signed, localHash, 3);
  } catch (error) {
    primaryError = error;
  }
  // Alchemy remains the primary RPC. If it rejects raw submission at the
  // JSON-RPC layer, submit the identical signed bytes through Robinhood's
  // public endpoint. A raw transaction is hash-idempotent, so this cannot
  // create a second wallet action.
  if (!transactionHash && primaryUrl.replace(/\/$/, "").toLowerCase() !== PUBLIC_ROBINHOOD_RPC_URL.toLowerCase()) {
    const fallbackClient = rpcClientFor(PUBLIC_ROBINHOOD_RPC_URL);
    try {
      transactionHash = await submitSignedTransaction(fallbackClient, signed, localHash, 2);
    } catch {
      // Check both providers one final time before reporting rejection.
      if (await transactionExists(primaryClient, localHash) || await transactionExists(fallbackClient, localHash)) {
        transactionHash = localHash;
      }
    }
  }
  if (!transactionHash) {
    // Do not propagate provider URLs because they may contain an API key.
    const message = primaryError instanceof Error ? primaryError.message.toLowerCase() : "";
    const reason = message.includes("insufficient") || message.includes("exceeds") || message.includes("balance")
      ? "transaction total cost (gas * gas fee + value) exceeds the balance"
      : message.includes("invalid") || message.includes("parameter")
        ? "RPC rejected the signed transaction parameters"
        : "RPC could not broadcast the signed transaction";
    throw new Error(reason);
  }
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
      if (request.expectedCreatorFeeRecipient) {
        const launched = await client.readContract({
          address: factory as Address,
          abi: ponsFactoryAbi,
          functionName: "getLaunchedToken",
          args: [result.tokenAddress as Address],
          blockNumber: receipt.blockNumber,
        });
        if (!launched.exists || launched.creatorFeeRecipient.toLowerCase() !== request.expectedCreatorFeeRecipient.toLowerCase()) {
          throw new Error("launch creator fee recipient mismatch");
        }
      }
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
          const metadata = await tokenMetadata(decoded.args.token);
          result.claimedDisplay = `${trimDecimal(formatUnits(decoded.args.amount, metadata.decimals))} ${metadata.symbol}`;
        }
      } catch (error) {
        if (error instanceof Error && /creator fee claim event mismatch/.test(error.message)) throw error;
      }
    }
    if (!result.claimedDisplay) throw new Error("verified creator fee claim event was not found");
  }
  if (receipt.status === "success" && request.operationType === "pons_v2_transfer_creator_fee_recipient") {
    if (!request.expectedFeeReassignmentToken || !request.expectedFeeReassignmentRecipient) {
      throw new Error("creator fee reassignment expectations were missing");
    }
    let verified = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== request.expectedTo.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: ponsFactoryAbi, data: log.data, topics: log.topics });
        if (decoded.eventName !== "CreatorFeeRecipientUpdated") continue;
        if (decoded.args.previousRecipient.toLowerCase() !== request.expectedFrom.toLowerCase()
          || decoded.args.token.toLowerCase() !== request.expectedFeeReassignmentToken.toLowerCase()
          || decoded.args.newRecipient.toLowerCase() !== request.expectedFeeReassignmentRecipient.toLowerCase()
          || decoded.args.newRecipient.toLowerCase() === request.expectedFrom.toLowerCase()
          || decoded.args.token === zeroAddress || decoded.args.newRecipient === zeroAddress) {
          throw new Error("creator fee reassignment event mismatch");
        }
        const launched = await client.readContract({
          address: request.expectedTo as Address, abi: ponsFactoryAbi, functionName: "getLaunchedToken",
          args: [decoded.args.token], blockNumber: receipt.blockNumber,
        });
        if (!launched.exists || launched.creatorFeeRecipient.toLowerCase() !== decoded.args.newRecipient.toLowerCase()) {
          throw new Error("creator fee reassignment post-state mismatch");
        }
        verified = true;
      } catch (error) {
        if (error instanceof Error && /creator fee reassignment/.test(error.message)) throw error;
      }
    }
    if (!verified) throw new Error("verified creator fee reassignment event was not found");
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
      const [balance, metadata] = await Promise.all([
        client.readContract({ address: outputToken, abi: tokenAbi, functionName: "balanceOf", args: [request.expectedFrom as Address], blockNumber: receipt.blockNumber }),
        tokenMetadata(outputToken),
      ]);
      after = balance;
      decimals = metadata.decimals;
      symbol = metadata.symbol;
    }
    const isBurn = request.operationType === "erc20_burn_to_dead";
    const verifiedAmount = isBurn ? before - after : after + adjustment - before;
    if (verifiedAmount <= 0n) throw new Error(isBurn
      ? "confirmed burn amount could not be verified"
      : "confirmed trade output could not be verified");
    result.tradeOutputDisplay = `${trimDecimal(formatUnits(verifiedAmount, decimals))} ${symbol}`;
    result.tradeOutputTokenAddress = outputToken;
    result.involvedPairTokenAddress = request.involvedPairTokenAddress;
  }
  return result;
}
