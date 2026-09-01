import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, serializeTransaction, stringToHex,
} from "viem";

const CHAIN_ID = 4663;
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmationIndex = args.indexOf("--confirm");
const suppliedConfirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
const configuredTokens = [...new Set((process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean))];
if (configuredTokens.length !== 1) throw new Error("exactly one manual test token must be configured");
const TOKEN = getAddress(configuredTokens[0]);
const VAULT = getAddress(required("AUTOMATED_FEE_MANUAL_TEST_VAULT_ADDRESS"));
if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") throw new Error("production automation must remain disabled");
if (process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() !== "true") throw new Error("manual testing is disabled");
const allowlist = configuredTokens.map((value) => value.toLowerCase());
if (allowlist.length !== 1 || allowlist[0] !== TOKEN.toLowerCase()) throw new Error("manual testing must be restricted exclusively to UTEST");

const keeper = getAddress(required("AUTOMATED_FEE_KEEPER_ADDRESS"));
const control = getAddress(required("AUTOMATED_FEE_CONTROL_ADDRESS"));
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");
const vaultAbi = parseAbi([
  "function token() view returns (address)", "function active() view returns (bool)", "function paused() view returns (bool)",
  "function lastCurveSweepBlock() view returns (uint256)", "function feeEscrow() view returns (address)",
  "function sweepCurveFees(uint256 minBuybackTokensOut)",
]);
const controlAbi = parseAbi(["function processingEnabled() view returns (bool)", "function keeper() view returns (address)"]);
const escrowAbi = parseAbi(["function balanceOf(address recipient) view returns (uint256)"]);
const [vaultToken, active, paused, processingEnabled, liveKeeper, lastSweep, escrow] = await Promise.all([
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "token" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "paused" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "keeper" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lastCurveSweepBlock" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "feeEscrow" }),
]);
if (vaultToken.toLowerCase() !== TOKEN.toLowerCase() || !active || paused || !processingEnabled || liveKeeper.toLowerCase() !== keeper.toLowerCase()) {
  throw new Error("UTEST manual sweep preconditions are not satisfied");
}
const balanceBefore = await client.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [VAULT] });
const confirmationToken = keccak256(stringToHex(["PONSBOT_UTEST_FIRST_SWEEP_V1", CHAIN_ID, TOKEN, VAULT, keeper].join(":")));
if (!execute) {
  console.log(JSON.stringify({
    mode: "read_only_utest_curve_sweep",
    mutationSent: false,
    confirmationToken,
    token: TOKEN,
    vault: VAULT,
    keeper,
    lastCurveSweepBlockBefore: lastSweep.toString(),
    escrowBalanceWeiBefore: balanceBefore.toString(),
  }, null, 2));
} else {
  if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("UTEST sweep requires the exact dry-run confirmation token");
  const cdp = new CdpClient({ apiKeyId: required("CDP_API_KEY_ID"), apiKeySecret: required("CDP_API_KEY_SECRET"), walletSecret: required("CDP_WALLET_SECRET") });
  const accountName = process.env.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-keeper";
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  if (account.address.toLowerCase() !== keeper.toLowerCase()) throw new Error("keeper CDP account mismatch");
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "sweepCurveFees", args: [0n] });
  await client.call({ account: keeper, to: VAULT, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: keeper, to: VAULT, data }), client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }), client.getBalance({ address: keeper }),
  ]);
  const baseFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (!baseFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseFee * 2n;
  if (balance < gas * maxFeePerGas) throw new Error("keeper has insufficient ETH");
  const transaction = { chainId: CHAIN_ID, type: "eip1559", to: VAULT, data, value: 0n, nonce, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp.evm.signTransaction({ address: keeper, transaction: serializeTransaction(transaction), idempotencyKey: `automated-fee-utest-sweep:${confirmationToken}:${lastSweep}:${nonce}` });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== keeper.toLowerCase() || parsed.chainId !== CHAIN_ID || Number(parsed.nonce) !== nonce
    || parsed.to?.toLowerCase() !== VAULT.toLowerCase() || parsed.data !== data || (parsed.value ?? 0n) !== 0n) throw new Error("signed sweep envelope mismatch");
  const transactionHash = keccak256(signature);
  const submittedHash = await client.sendRawTransaction({ serializedTransaction: signature });
  if (submittedHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned an unexpected sweep hash");
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("UTEST sweep reverted");
  const [lastCurveSweepBlock, escrowBalance] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "lastCurveSweepBlock" }),
    client.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [VAULT] }),
  ]);
  if (lastCurveSweepBlock <= lastSweep) throw new Error("UTEST sweep marker did not advance");
  console.log(JSON.stringify({
    status: "utest_curve_fees_swept",
    mutationSent: true,
    token: TOKEN,
    vault: VAULT,
    transactionHash,
    lastCurveSweepBlock: lastCurveSweepBlock.toString(),
    escrowBalanceWeiBefore: balanceBefore.toString(),
    escrowBalanceWeiAfter: escrowBalance.toString(),
  }, null, 2));
}
