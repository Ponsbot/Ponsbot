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
  "function selfBurnBps() view returns (uint16)",
  "function configurationNonce() view returns (uint256)",
  "function executionNonce() view returns (uint256)",
  "function payableTo(address) view returns (uint256)",
  "function burnReserve(address) view returns (uint256)",
  "function setPercentage(uint16 bps)",
  "function reassign(address nextOwner)",
  "function collect()",
  "function withdrawFor(address beneficiary)",
  "function releaseReserve(uint256 amount)",
  "function shareWithHolders()",
  "function emergencyExitToOwner()",
  "function executeBurn(address beneficiary,uint256 amount,uint256 minimumOut,uint256 deadline,bytes route,bytes signature) returns (uint256)",
]);

/** Raw CDP signHash digest, not personal_sign. Exact Solidity ABI encoding. */
export function creatorBurnQuoteDigest(q: {
  chainId: bigint; layer: Address; upstream: Address; token: Address; asset: Address;
  beneficiary: Address; amount: bigint; minimumOut: bigint; deadline: bigint;
  executor: Address; route: Hex; configurationNonce: bigint; executionNonce: bigint;
}): Hex {
  return keccak256(encodeAbiParameters([
    { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
    { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" },
    { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "uint256" }, { type: "uint256" },
  ], ["PonsBotCreatorBurnVault:1", q.chainId, q.layer, q.upstream, q.token, q.asset,
    q.beneficiary, q.amount, q.minimumOut, q.deadline, q.executor, keccak256(q.route), q.configurationNonce, q.executionNonce]));
}
