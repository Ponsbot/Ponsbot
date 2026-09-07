import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";
import { creatorBurnVaultAbi } from "./creator-burn-policy";

const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const native = "0x0000000000000000000000000000000000000000";
type ReceiptLog = { address: Address; topics: [Hex, ...Hex[]] | []; data: Hex; logIndex: number | null };
export type CreatorBurnLedgerEvent = {
  key: string; owner: Address; kind: "allocation" | "surplus" | "payout" | "burn";
  received: bigint; cashAllocated: bigint; reserveAllocated: bigint;
  cashDebited: bigint; cashReceived: bigint; reserveSpent: bigint; tokensBurned: bigint;
};

/** Use ONLY after authenticating the layer registry/code and receipt finality.
 * Allocation to the layer is not a wallet payout. Surplus is not creator revenue.
 * Each immutable log key must be inserted once in the durable ledger.
 */
export function creatorBurnReceiptEvents(input: {
  chainId: number; layer: Address; asset: Address; transactionHash: Hex;
  status: "success" | "reverted"; logs: ReceiptLog[];
}): CreatorBurnLedgerEvent[] {
  if (input.chainId !== 4663 || input.status !== "success") throw new Error("CREATOR_BURN_RECEIPT_NOT_CONFIRMED");
  const result: CreatorBurnLedgerEvent[] = [];
  const keys = new Set<string>();
  for (const log of input.logs) {
    if (!equal(log.address, input.layer)) continue;
    // An ABI decode failure is intentionally not converted to an empty payout.
    // Ignore non-ledger layer events, but fail if a purported ledger log is corrupt.
    let event;
    try { event = decodeEventLog({ abi: creatorBurnVaultAbi, topics: log.topics, data: log.data, strict: true }); }
    catch { throw new Error("CREATOR_BURN_UNRECOGNIZED_LAYER_EVENT"); }
    if (event.eventName !== "Allocation" && event.eventName !== "SurplusReceived"
      && event.eventName !== "Paid" && event.eventName !== "SelfBurned") continue;
    if (log.logIndex === null || log.logIndex < 0 || !Number.isInteger(log.logIndex)) throw new Error("CREATOR_BURN_RECEIPT_LOG_INDEX");
    const key = `${input.chainId}:${input.layer.toLowerCase()}:${input.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (keys.has(key)) throw new Error("CREATOR_BURN_DUPLICATE_RECEIPT_LOG");
    keys.add(key);
    const row: CreatorBurnLedgerEvent = { key, owner: event.args.owner, kind: "allocation", received: 0n,
      cashAllocated: 0n, reserveAllocated: 0n, cashDebited: 0n, cashReceived: 0n, reserveSpent: 0n, tokensBurned: 0n };
    if (event.eventName === "Allocation") {
      if (event.args.received !== event.args.cash + event.args.reserve) throw new Error("CREATOR_BURN_ALLOCATION_MISMATCH");
      Object.assign(row, { received: event.args.received, cashAllocated: event.args.cash, reserveAllocated: event.args.reserve });
    } else if (event.eventName === "SurplusReceived") {
      Object.assign(row, { kind: "surplus", cashAllocated: event.args.amount });
    } else if (event.eventName === "SelfBurned") {
      Object.assign(row, { kind: "burn", reserveSpent: event.args.spent, tokensBurned: event.args.burned });
    } else if (event.eventName === "Paid") {
      let delivered = event.args.amount;
      if (!equal(input.asset, native)) {
        delivered = 0n;
        for (const transferLog of input.logs) {
          if (!equal(transferLog.address, input.asset)) continue;
          try {
            const transfer = decodeEventLog({ abi: transferAbi, topics: transferLog.topics, data: transferLog.data, strict: true });
            if (equal(transfer.args.from, input.layer) && equal(transfer.args.to, event.args.owner)) delivered += transfer.args.value;
          } catch { /* Other events from the fee asset do not represent payment. */ }
        }
        if (delivered <= 0n || delivered > event.args.amount) throw new Error("CREATOR_BURN_PAYOUT_TRANSFER_MISMATCH");
      }
      Object.assign(row, { kind: "payout", cashDebited: event.args.amount, cashReceived: delivered });
    }
    result.push(row);
  }
  // Current layer entrypoints allow at most one payout per transaction. Reject
  // ambiguous batched receipts instead of counting the same ERC-20 transfer twice.
  if (result.filter(row => row.kind === "payout").length > 1) throw new Error("CREATOR_BURN_MULTIPLE_PAYOUTS");
  return result;
}
