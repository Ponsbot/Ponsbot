import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";

/** Separate rollout gate. No existing fee processing depends on this flag. */
export function creatorBurnEnabled(environment: Record<string, string | undefined>) {
  return environment.CREATOR_SELF_BUYBACK_ENABLED === "true";
}

export function creatorBurnPercentageBps(value: string): number {
  const match = value.trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/);
  if (!match) throw new Error("Use a percentage from 0 to 100 with at most two decimal places.");
  const bps = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (bps > 10_000) throw new Error("Percentage cannot exceed 100%.");
  return bps;
}

export function creatorBurnSplit(gross: bigint, bps: number) {
  if (gross < 0n || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("Invalid creator-fee allocation");
  const ponsbot = gross * 500n / 10_000n;
  const creatorShare = gross - ponsbot;
  const selfBuyback = creatorShare * BigInt(bps) / 10_000n;
  return { ponsbot, selfBuyback, cash: creatorShare - selfBuyback };
}

export const creatorBurnVaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function upstream() view returns (address)",
  "function token() view returns (address)",
  "function asset() view returns (address)",
  "function active() view returns (bool)",
  "function exited() view returns (bool)",
  "function everActivated() view returns (bool)",
  "function feeControl() view returns (address)",
  "function executor() view returns (address)",
  "function MAX_QUOTE_LIFETIME() view returns (uint256)",
  "function accounted() view returns (uint256)",
  "function lifetimeSelfBurned() view returns (uint256)",
  "function lifetimeSelfSpend() view returns (uint256)",
  "function selfBurnBps() view returns (uint16)",
  "function configurationNonce() view returns (uint256)",
  "function executionNonce() view returns (uint256)",
  "function payableTo(address) view returns (uint256)",
  "function burnReserve(address) view returns (uint256)",
  "function setPercentage(uint16 bps)",
  "function reassign(address nextOwner)",
  "function collect()",
  "function collectAndPay()",
  "function syncDormantOwner()",
  "function withdrawFor(address beneficiary)",
  "function releaseReserve(uint256 amount)",
  "function shareWithHolders()",
  "function emergencyExitToOwner()",
  "function detach((uint256 maxBuybackAmount,uint256 minPonsbotOut,uint256 minSweepBuybackTokensOut,uint256 deadline,address routeTarget,bytes routeData,bytes quoteSignature) authorization)",
  "function executeBurn(address beneficiary,uint256 amount,uint256 minimumOut,uint256 issuedAt,uint256 deadline,bytes route,bytes signature) returns (uint256)",
  "function burnDigest(address beneficiary,uint256 amount,uint256 minimumOut,uint256 issuedAt,uint256 deadline,bytes32 routeHash) view returns (bytes32)",
  "event Allocation(address indexed owner,uint256 received,uint256 cash,uint256 reserve)",
  "event SurplusReceived(address indexed owner,uint256 amount)",
  "event Paid(address indexed owner,uint256 amount)",
  "event SelfBurned(address indexed owner,uint256 spent,uint256 burned)",
  "event ConfigurationChanged(address indexed owner,uint16 bps,uint256 nonce)",
  "event OwnershipChanged(address indexed previousOwner,address indexed nextOwner)",
  "event ReserveReleased(address indexed owner,uint256 amount)",
  "event Exited(address indexed recipient)",
]);

/** Raw CDP signHash digest, not personal_sign. Exact Solidity ABI encoding. */
export function creatorBurnQuoteDigest(q: {
  chainId: bigint; layer: Address; upstream: Address; token: Address; asset: Address;
  beneficiary: Address; amount: bigint; minimumOut: bigint; issuedAt: bigint; deadline: bigint;
  executor: Address; route: Hex; configurationNonce: bigint; executionNonce: bigint;
}): Hex {
  const trade = keccak256(encodeAbiParameters([
    { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
  ], [q.token, q.asset, q.beneficiary, q.amount, q.minimumOut]));
  const validity = keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
  ], [q.issuedAt, q.deadline, q.executor, keccak256(q.route), q.configurationNonce, q.executionNonce]));
  return keccak256(encodeAbiParameters([
    { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
  ], ["PonsBotCreatorBurnVault:2", q.chainId, q.layer, q.upstream, trade, validity]));
}
