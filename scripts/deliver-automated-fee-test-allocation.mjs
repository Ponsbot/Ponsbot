import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, serializeTransaction, stringToHex, zeroAddress,
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
const BENEFICIARY = getAddress(required("AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS"));
if (process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true") throw new Error("production automation must remain disabled");
if (process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() !== "true") throw new Error("manual testing is disabled");
const allowlist = configuredTokens.map((value) => value.toLowerCase());
if (allowlist.length !== 1 || allowlist[0] !== TOKEN.toLowerCase()) throw new Error("manual testing must be restricted exclusively to UTEST");
const keeper = getAddress(required("AUTOMATED_FEE_KEEPER_ADDRESS"));
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }) });
if (await client.getChainId() !== CHAIN_ID) throw new Error("Robinhood RPC chain mismatch");
const vaultAbi = parseAbi([
  "function token() view returns (address)", "function beneficiary() view returns (address)",
  "function active() view returns (bool)", "function claimable(address beneficiary,address asset) view returns (uint256)",
  "function deliverBeneficiaryAllocation(address beneficiaryAddress,address asset,uint256 amount)",
]);
const [vaultToken, beneficiary, active, amount] = await Promise.all([
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "token" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "beneficiary" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimable", args: [BENEFICIARY, zeroAddress] }),
]);
if (vaultToken.toLowerCase() !== TOKEN.toLowerCase() || beneficiary.toLowerCase() !== BENEFICIARY.toLowerCase() || !active) throw new Error("UTEST beneficiary binding is invalid");
const confirmationToken = keccak256(stringToHex(["PONSBOT_UTEST_DELIVER_V1", CHAIN_ID, TOKEN, VAULT, BENEFICIARY, amount].join(":")));
if (amount === 0n) {
  console.log(JSON.stringify({ status: "no_creator_allocation_to_deliver", mutationSent: false, token: TOKEN, vault: VAULT, beneficiary: BENEFICIARY, amountWei: "0" }, null, 2));
} else if (!execute) {
  console.log(JSON.stringify({ mode: "read_only_utest_creator_delivery", mutationSent: false, confirmationToken, token: TOKEN, vault: VAULT, beneficiary: BENEFICIARY, amountWei: amount.toString() }, null, 2));
} else {
  if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("UTEST delivery requires the exact fresh confirmation token");
  const cdp = new CdpClient({ apiKeyId: required("CDP_API_KEY_ID"), apiKeySecret: required("CDP_API_KEY_SECRET"), walletSecret: required("CDP_WALLET_SECRET") });
  const account = await cdp.evm.getOrCreateAccount({ name: process.env.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-keeper" });
  if (account.address.toLowerCase() !== keeper.toLowerCase()) throw new Error("keeper CDP account mismatch");
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "deliverBeneficiaryAllocation", args: [BENEFICIARY, zeroAddress, amount] });
  await client.call({ account: keeper, to: VAULT, data });
  const [estimatedGas, fees, nonce, keeperBalance, beneficiaryBefore] = await Promise.all([
    client.estimateGas({ account: keeper, to: VAULT, data }), client.estimateFeesPerGas(),
    client.getTransactionCount({ address: keeper, blockTag: "pending" }), client.getBalance({ address: keeper }),
    client.getBalance({ address: BENEFICIARY }),
  ]);
  const baseFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (!baseFee) throw new Error("RPC did not return a usable gas fee");
  const gas = estimatedGas * 120n / 100n;
  const maxFeePerGas = baseFee * 2n;
  if (keeperBalance < gas * maxFeePerGas) throw new Error("keeper has insufficient ETH");
  const transaction = { chainId: CHAIN_ID, type: "eip1559", to: VAULT, data, value: 0n, nonce, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  const { signature } = await cdp.evm.signTransaction({ address: keeper, transaction: serializeTransaction(transaction), idempotencyKey: `automated-fee-utest-deliver:${confirmationToken}:${nonce}` });
  const sender = await recoverTransactionAddress({ serializedTransaction: signature });
  const parsed = parseTransaction(signature);
  if (sender.toLowerCase() !== keeper.toLowerCase() || parsed.chainId !== CHAIN_ID || parsed.to?.toLowerCase() !== VAULT.toLowerCase()
    || parsed.data !== data || (parsed.value ?? 0n) !== 0n) throw new Error("signed delivery envelope mismatch");
  const transactionHash = keccak256(signature);
  const submittedHash = await client.sendRawTransaction({ serializedTransaction: signature });
  if (submittedHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned an unexpected delivery hash");
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("UTEST creator delivery reverted");
  const [remaining, beneficiaryAfter] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimable", args: [BENEFICIARY, zeroAddress] }),
    client.getBalance({ address: BENEFICIARY }),
  ]);
  if (remaining !== 0n || beneficiaryAfter - beneficiaryBefore !== amount) throw new Error("creator delivery postcondition failed");
  console.log(JSON.stringify({ status: "utest_creator_allocation_delivered", mutationSent: true, transactionHash, token: TOKEN, vault: VAULT, beneficiary: BENEFICIARY, amountWei: amount.toString(), claimableWeiAfter: remaining.toString() }, null, 2));
}
