import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, serializeTransaction, stringToHex, zeroAddress,
} from "viem";

const CHAIN_ID = 4663;
const PONSBOT = getAddress("0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07");
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmationIndex = args.indexOf("--confirm");
const suppliedConfirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
function address(name, fallback = "") { return getAddress(String(process.env[name] ?? fallback).trim()); }
const configuredTokens = [...new Set((process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean))];
if (configuredTokens.length !== 1) throw new Error("exactly one manual test token must be configured");
const TOKEN = getAddress(configuredTokens[0]);
const VAULT = address("AUTOMATED_FEE_MANUAL_TEST_VAULT_ADDRESS");
if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") throw new Error("production automation must remain disabled");
if (process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() !== "true") throw new Error("manual testing is disabled");
const allowlist = configuredTokens.map((value) => value.toLowerCase());
if (allowlist.length !== 1 || allowlist[0] !== TOKEN.toLowerCase()) throw new Error("manual testing must be restricted exclusively to UTEST");

const keeper = address("AUTOMATED_FEE_KEEPER_ADDRESS");
const authorizer = address("AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS");
const control = address("AUTOMATED_FEE_CONTROL_ADDRESS");
const nativeExecutor = address("AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS");
const quoter = address("PONS_V4_QUOTER_ADDRESS", "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
const slippageBps = Number(process.env.AUTOMATED_FEE_QUOTE_SLIPPAGE_BPS ?? "300");
if (!Number.isInteger(slippageBps) || slippageBps < 50 || slippageBps > 1_000) throw new Error("automated fee slippage is invalid");
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");
if (!(await client.getCode({ address: quoter }))) throw new Error("configured Pons V4 quoter has no bytecode");

const vaultAbi = parseAbi([
  "function token() view returns (address)", "function pairAsset() view returns (address)", "function ponsFactory() view returns (address)",
  "function feeEscrow() view returns (address)", "function controller() view returns (address)", "function beneficiary() view returns (address)",
  "function active() view returns (bool)", "function paused() view returns (bool)", "function lastCurveSweepBlock() view returns (uint256)",
  "function executionNonce() view returns (uint256)", "function claimable(address beneficiary,address asset) view returns (uint256)",
  "function lifetimeGrossClaimed(address asset) view returns (uint256)", "function lifetimeBeneficiaryAllocated(address asset) view returns (uint256)",
  "function lifetimeBuybackSpent(address asset) view returns (uint256)", "function lifetimePonsbotBurned() view returns (uint256)",
  "function processFees((uint256 maxBuybackAmount,uint256 minPonsbotOut,uint256 minSweepBuybackTokensOut,uint256 deadline,address routeTarget,bytes routeData,bytes quoteSignature) execution) returns (uint256 gross,uint256 burned)",
]);
const controlAbi = parseAbi([
  "function processingEnabled() view returns (bool)", "function keeper() view returns (address)",
  "function quoteAuthorizer() view returns (address)", "function executionAdapter() view returns (address)",
]);
const factoryAbi = parseAbi([
  "function memeHook() view returns (address)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
]);
const escrowAbi = parseAbi(["function balanceOf(address recipient) view returns (uint256)"]);
const tokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const adapterAbi = parseAbi(["function allowedExecutor(address executor) view returns (bool)"]);

const [vaultToken, pairAsset, ponsFactory, feeEscrow, controller, beneficiary, active, paused, lastSweep, nonce,
  processingEnabled, liveKeeper, liveAuthorizer, adapter] = await Promise.all([
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "token" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "pairAsset" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "ponsFactory" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "feeEscrow" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "controller" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "beneficiary" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "paused" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lastCurveSweepBlock" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "executionNonce" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "keeper" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "quoteAuthorizer" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "executionAdapter" }),
]);
if (vaultToken.toLowerCase() !== TOKEN.toLowerCase() || pairAsset !== zeroAddress || controller.toLowerCase() !== beneficiary.toLowerCase()
  || !active || paused || !processingEnabled || lastSweep === 0n || liveKeeper.toLowerCase() !== keeper.toLowerCase()
  || liveAuthorizer.toLowerCase() !== authorizer.toLowerCase()) throw new Error("UTEST processing preconditions are not satisfied");
const [launch, ponsbotLaunch, hook, escrowBalance, executorAllowed] = await Promise.all([
  client.readContract({ address: ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [TOKEN] }),
  client.readContract({ address: ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [PONSBOT] }),
  client.readContract({ address: ponsFactory, abi: factoryAbi, functionName: "memeHook" }),
  client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [VAULT] }),
  client.readContract({ address: adapter, abi: adapterAbi, functionName: "allowedExecutor", args: [nativeExecutor] }),
]);
if (!launch.exists || launch.phase !== 0 || launch.creatorFeeRecipient.toLowerCase() !== VAULT.toLowerCase()) throw new Error("UTEST is not a valid bonding-curve vault launch");
if (!ponsbotLaunch.exists || ponsbotLaunch.phase !== 2 || ponsbotLaunch.pairToken !== zeroAddress || !executorAllowed) throw new Error("canonical PONSBOT buyback route is unavailable");
const maxBuybackAmount = escrowBalance * 500n / 10_000n;
if (maxBuybackAmount === 0n) throw new Error("UTEST escrow has no processable buyback amount");
const quote = await client.simulateContract({
  address: quoter,
  abi: quoterAbi,
  functionName: "quoteExactInputSingle",
  args: [{
    poolKey: { currency0: zeroAddress, currency1: PONSBOT, fee: ponsbotLaunch.poolFee, tickSpacing: ponsbotLaunch.tickSpacing, hooks: hook },
    zeroForOne: true,
    exactAmount: maxBuybackAmount,
    hookData: "0x",
  }],
});
const quotedPonsbot = quote.result[0];
const minPonsbotOut = quotedPonsbot * BigInt(10_000 - slippageBps) / 10_000n;
if (minPonsbotOut === 0n) throw new Error("live PONSBOT quote is below minimum output");
const confirmationToken = keccak256(stringToHex([
  "PONSBOT_UTEST_FIRST_PROCESS_V1", CHAIN_ID, TOKEN, VAULT, escrowBalance, maxBuybackAmount, nonce, nativeExecutor,
].join(":")));
if (!execute) {
  console.log(JSON.stringify({
    mode: "read_only_utest_95_5_processing_plan",
    mutationSent: false,
    confirmationToken,
    token: TOKEN,
    vault: VAULT,
    grossCreatorFeesWei: escrowBalance.toString(),
    beneficiaryAllocationWei: (escrowBalance - maxBuybackAmount).toString(),
    buybackAmountWei: maxBuybackAmount.toString(),
    quotedPonsbot: quotedPonsbot.toString(),
    minimumPonsbotToBurn: minPonsbotOut.toString(),
    slippageBps,
    executionNonce: nonce.toString(),
  }, null, 2));
} else {
  if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("UTEST processing requires a fresh exact dry-run confirmation token");
  const cdp = new CdpClient({ apiKeyId: required("CDP_API_KEY_ID"), apiKeySecret: required("CDP_API_KEY_SECRET"), walletSecret: required("CDP_WALLET_SECRET") });
  const [keeperAccount, quoteAccount] = await Promise.all([
    cdp.evm.getOrCreateAccount({ name: process.env.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-keeper" }),
    cdp.evm.getOrCreateAccount({ name: process.env.AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-quotes" }),
  ]);
  if (keeperAccount.address.toLowerCase() !== keeper.toLowerCase() || quoteAccount.address.toLowerCase() !== authorizer.toLowerCase()) throw new Error("automated fee CDP role mismatch");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const routeData = "0x";
  const quoteSignatureResult = await quoteAccount.signTypedData({
    domain: { name: "PonsBotFeeVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT },
    types: { ExecutionAuthorization: [
      { name: "pairAsset", type: "address" }, { name: "maxBuybackAmount", type: "uint256" },
      { name: "minPonsbotOut", type: "uint256" }, { name: "minSweepBuybackTokensOut", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "routeTarget", type: "address" },
      { name: "routeDataHash", type: "bytes32" }, { name: "nonce", type: "uint256" },
    ] },
    primaryType: "ExecutionAuthorization",
    message: { pairAsset: zeroAddress, maxBuybackAmount, minPonsbotOut, minSweepBuybackTokensOut: 0n, deadline, routeTarget: nativeExecutor, routeDataHash: keccak256(routeData), nonce },
  });
  const quoteSignature = typeof quoteSignatureResult === "string" ? quoteSignatureResult : quoteSignatureResult.signature;
  if (!/^0x[a-fA-F0-9]{130}$/.test(quoteSignature)) throw new Error("quote authorizer returned an invalid signature");
  const execution = { maxBuybackAmount, minPonsbotOut, minSweepBuybackTokensOut: 0n, deadline, routeTarget: nativeExecutor, routeData, quoteSignature };
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "processFees", args: [execution] });
  await client.call({ account: keeper, to: VAULT, data });
  const [estimatedGas, fees, transactionNonce, keeperBalance, deadBefore, claimableBefore, grossBefore, allocatedBefore, buybackBefore, burnedBefore] = await Promise.all([
    client.estimateGas({ account: keeper, to: VAULT, data }), client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }), client.getBalance({ address: keeper }),
    client.readContract({ address: PONSBOT, abi: tokenAbi, functionName: "balanceOf", args: [DEAD] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimable", args: [beneficiary, zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeGrossClaimed", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeBeneficiaryAllocated", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeBuybackSpent", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimePonsbotBurned" }),
  ]);
  const baseFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (!baseFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseFee * 2n;
  if (keeperBalance < gas * maxFeePerGas) throw new Error("keeper has insufficient ETH");
  const transaction = { chainId: CHAIN_ID, type: "eip1559", to: VAULT, data, value: 0n, nonce: transactionNonce, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp.evm.signTransaction({ address: keeper, transaction: serializeTransaction(transaction), idempotencyKey: `automated-fee-utest-process:${confirmationToken}:${nonce}` });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== keeper.toLowerCase() || parsed.chainId !== CHAIN_ID || parsed.to?.toLowerCase() !== VAULT.toLowerCase()
    || parsed.data !== data || (parsed.value ?? 0n) !== 0n) throw new Error("signed processing envelope mismatch");
  const transactionHash = keccak256(signature);
  const submittedHash = await client.sendRawTransaction({ serializedTransaction: signature });
  if (submittedHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned an unexpected processing hash");
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("UTEST fee processing reverted");
  const [escrowAfter, deadAfter, claimableAfter, grossAfter, allocatedAfter, buybackAfter, burnedAfter, nonceAfter, sweepAfter] = await Promise.all([
    client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [VAULT] }),
    client.readContract({ address: PONSBOT, abi: tokenAbi, functionName: "balanceOf", args: [DEAD] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimable", args: [beneficiary, zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeGrossClaimed", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeBeneficiaryAllocated", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimeBuybackSpent", args: [zeroAddress] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lifetimePonsbotBurned" }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "executionNonce" }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lastCurveSweepBlock" }),
  ]);
  const expectedAllocation = escrowBalance - maxBuybackAmount;
  const actualBurned = deadAfter - deadBefore;
  if (escrowAfter !== 0n || claimableAfter - claimableBefore !== expectedAllocation || grossAfter - grossBefore !== escrowBalance
    || allocatedAfter - allocatedBefore !== expectedAllocation || buybackAfter - buybackBefore !== maxBuybackAmount
    || burnedAfter - burnedBefore !== actualBurned || actualBurned < minPonsbotOut || nonceAfter !== nonce + 1n || sweepAfter !== 0n) {
    throw new Error("UTEST post-processing accounting verification failed");
  }
  console.log(JSON.stringify({
    status: "utest_creator_fees_processed_95_5",
    mutationSent: true,
    transactionHash,
    grossCreatorFeesWei: escrowBalance.toString(),
    beneficiaryAllocatedWei: expectedAllocation.toString(),
    buybackSpentWei: maxBuybackAmount.toString(),
    ponsbotBurned: actualBurned.toString(),
    beneficiaryClaimableWei: claimableAfter.toString(),
    escrowBalanceWeiAfter: escrowAfter.toString(),
  }, null, 2));
}
