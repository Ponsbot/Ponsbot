import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Abi, type Address, type Hex } from "viem";
import { creatorBurnReceiptEvents } from "../lib/creator-burn-receipts";
const layer="0x1111111111111111111111111111111111111111" as Address;
const owner="0x2222222222222222222222222222222222222222" as Address;
const asset="0x3333333333333333333333333333333333333333" as Address;
const native="0x0000000000000000000000000000000000000000" as Address;
const tx=`0x${"a".repeat(64)}` as Hex;
function event(name:"Allocation"|"Paid"|"SurplusReceived"|"SelfBurned"|"ReserveReleased", amounts:bigint[], index=0) {
  const declarations={Allocation:"event Allocation(address indexed owner,uint256 received,uint256 cash,uint256 reserve)",
    Paid:"event Paid(address indexed owner,uint256 amount)",SurplusReceived:"event SurplusReceived(address indexed owner,uint256 amount)",
    SelfBurned:"event SelfBurned(address indexed owner,uint256 spent,uint256 burned)", ReserveReleased:"event ReserveReleased(address indexed owner,uint256 amount)"};
  return {address:layer,topics:encodeEventTopics({abi:parseAbi([declarations[name]]) as Abi,eventName:name,args:{owner}}) as [Hex,...Hex[]],
    data:encodeAbiParameters(amounts.map(()=>({type:"uint256"})),amounts),logIndex:index};
}
function transfer(value:bigint) {
  return {address:asset,topics:encodeEventTopics({abi:parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]),
    eventName:"Transfer",args:{from:layer,to:owner}}) as [Hex,...Hex[]],data:encodeAbiParameters([{type:"uint256"}],[value]),logIndex:8};
}
const base={chainId:4663,layer,asset:native,transactionHash:tx,status:"success" as const};
describe("creator layer receipts",()=>{
  it("records a returned reserve without inventing a burn or new fee revenue", () => {
    expect(creatorBurnReceiptEvents({ ...base, logs: [event("ReserveReleased", [47n])] })[0])
      .toMatchObject({ kind: "reserve_release", reserveReleased: 47n, reserveSpent: 0n, tokensBurned: 0n, received: 0n, cashReceived: 0n });
  });
  it("separates 95% allocation from actual cash paid",()=>{
    const rows=creatorBurnReceiptEvents({...base,logs:[event("Allocation",[95n,48n,47n]),event("Paid",[48n],1)]});
    expect(rows[0]).toMatchObject({received:95n,cashAllocated:48n,reserveAllocated:47n,cashReceived:0n});
    expect(rows[1]).toMatchObject({received:0n,cashReceived:48n,cashDebited:48n});
  });
  it("does not count surplus as creator fee revenue",()=>{
    expect(creatorBurnReceiptEvents({...base,logs:[event("SurplusReceived",[10n])]} )[0]).toMatchObject({kind:"surplus",received:0n,cashAllocated:10n});
  });
  it("uses actual ERC20 transfer output, not nominal debited cash",()=>{
    expect(creatorBurnReceiptEvents({...base,asset,logs:[transfer(47n),event("Paid",[48n])]} )[0]).toMatchObject({cashReceived:47n,cashDebited:48n});
  });
  it("rejects an unverified ERC20 payout",()=>expect(()=>creatorBurnReceiptEvents({...base,asset,logs:[event("Paid",[48n])]})).toThrow("TRANSFER_MISMATCH"));
  it("does not treat another layer's events as this layer's receipts",()=>expect(creatorBurnReceiptEvents({...base,logs:[{...event("Paid",[48n]),address:owner}]})).toEqual([]));
  it("rejects allocation arithmetic errors",()=>expect(()=>creatorBurnReceiptEvents({...base,logs:[event("Allocation",[95n,48n,48n])]})).toThrow("ALLOCATION_MISMATCH"));
  it("provides stable per-log deduplication keys",()=>{
    const input={...base,logs:[event("SelfBurned",[47n,100n])]};
    expect(creatorBurnReceiptEvents(input)[0].key).toBe(creatorBurnReceiptEvents(input)[0].key);
    expect(()=>creatorBurnReceiptEvents({...base,logs:[...input.logs,...input.logs]})).toThrow("DUPLICATE");
  });
  it("rejects reverted and wrong-chain receipts",()=>{
    expect(()=>creatorBurnReceiptEvents({...base,status:"reverted",logs:[]})).toThrow();
    expect(()=>creatorBurnReceiptEvents({...base,chainId:1,logs:[]})).toThrow();
  });
  it("refuses ambiguous multiple payout receipts",()=>expect(()=>creatorBurnReceiptEvents({...base,logs:[event("Paid",[1n]),event("Paid",[1n],1)]})).toThrow("MULTIPLE_PAYOUTS"));
});
