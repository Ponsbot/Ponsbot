import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, zeroAddress } from "viem";

const configuredTokens = String(process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
if (configuredTokens.length !== 1) throw new Error("exactly one manual test token must be configured");
const token = getAddress(configuredTokens[0]);
const vault = getAddress(process.env.AUTOMATED_FEE_MANUAL_TEST_VAULT_ADDRESS ?? "");
const controller = getAddress(process.env.AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS ?? "");
const keeper = getAddress(process.env.AUTOMATED_FEE_KEEPER_ADDRESS ?? "");
const control = getAddress(process.env.AUTOMATED_FEE_CONTROL_ADDRESS ?? "");
const client = createPublicClient({
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000, retryCount: 3 }),
});

const vaultAbi = parseAbi([
  "function ponsFactory() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function lastCurveSweepBlock() view returns (uint256)",
  "function claimable(address beneficiary,address asset) view returns (uint256)",
  "function lifetimeGrossClaimed(address asset) view returns (uint256)",
  "function lifetimeBeneficiaryAllocated(address asset) view returns (uint256)",
  "function lifetimeBuybackSpent(address asset) view returns (uint256)",
  "function lifetimePonsbotBurned() view returns (uint256)",
  "function sweepCurveFees(uint256 minBuybackTokensOut)",
]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
]);
const escrowAbi = parseAbi(["function balanceOf(address recipient) view returns (uint256)"]);
const controlAbi = parseAbi(["function processingEnabled() view returns (bool)"]);

const [ponsFactory, feeEscrow, active, paused, lastCurveSweepBlock, claimable, gross, allocated, buyback, burned, processingEnabled] = await Promise.all([
  client.readContract({ address: vault, abi: vaultAbi, functionName: "ponsFactory" }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "feeEscrow" }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "active" }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "lastCurveSweepBlock" }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "claimable", args: [controller, zeroAddress] }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "lifetimeGrossClaimed", args: [zeroAddress] }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "lifetimeBeneficiaryAllocated", args: [zeroAddress] }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "lifetimeBuybackSpent", args: [zeroAddress] }),
  client.readContract({ address: vault, abi: vaultAbi, functionName: "lifetimePonsbotBurned" }),
  client.readContract({ address: control, abi: controlAbi, functionName: "processingEnabled" }),
]);
const [launched, escrowBalance, keeperBalance] = await Promise.all([
  client.readContract({ address: ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] }),
  client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [vault] }),
  client.getBalance({ address: keeper }),
]);
let sweepSimulation = { supported: false, reason: "not attempted" };
try {
  await client.call({
    account: keeper,
    to: vault,
    data: encodeFunctionData({ abi: vaultAbi, functionName: "sweepCurveFees", args: [0n] }),
  });
  sweepSimulation = { supported: true, reason: null };
} catch (error) {
  sweepSimulation = { supported: false, reason: error instanceof Error ? error.shortMessage || error.message : String(error) };
}
console.log(JSON.stringify({
  mutationSent: false,
  token,
  vault,
  phase: launched.phase,
  creatorFeeRecipient: launched.creatorFeeRecipient,
  active,
  paused,
  processingEnabled,
  lastCurveSweepBlock: lastCurveSweepBlock.toString(),
  escrowBalanceWei: escrowBalance.toString(),
  controllerClaimableWei: claimable.toString(),
  lifetimeGrossClaimedWei: gross.toString(),
  lifetimeBeneficiaryAllocatedWei: allocated.toString(),
  lifetimeBuybackSpentWei: buyback.toString(),
  lifetimePonsbotBurned: burned.toString(),
  keeperBalanceWei: keeperBalance.toString(),
  sweepSimulation,
}, null, 2));
