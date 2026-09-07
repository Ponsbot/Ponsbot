import { describe, expect, it } from "vitest";
import { nextCreatorBurnStep, creatorBurnRetryAt, creatorBurnReceiptDueAt, assertCreatorBurnEnrollmentOwner, type CreatorBurnCycleSnapshot } from "../lib/creator-burn-cycle";
const base: CreatorBurnCycleSnapshot = {enabled:true,active:true,now:100000,upstreamClaimable:0n,cash:0n,reserve:0n,nextBurnAt:0,burnFailures:0};
describe("creator burn/payout sequencing",()=>{
  it("collects newly confirmed upstream fees immediately",()=>expect(nextCreatorBurnStep({...base,upstreamClaimable:95n})).toEqual({kind:"execute",stage:"collect",dueAt:base.now}));
  it("pays cash before attempting a burn",()=>expect(nextCreatorBurnStep({...base,cash:47n,reserve:48n,nextBurnAt:9999999})).toEqual({kind:"execute",stage:"payout",dueAt:base.now}));
  it("does not hold cash for the upstream accumulation threshold",()=>expect(nextCreatorBurnStep({...base,cash:1n})).toMatchObject({stage:"payout"}));
  it("pays cash even if collection is backing off",()=>expect(nextCreatorBurnStep({...base,cash:1n,upstreamClaimable:2n,collectRetryAt:200000})).toMatchObject({stage:"payout"}));
  it("collects while a payout is backing off but never starts a burn",()=>{
    expect(nextCreatorBurnStep({...base,cash:1n,upstreamClaimable:2n,payoutRetryAt:200000})).toMatchObject({stage:"collect"});
    expect(nextCreatorBurnStep({...base,cash:1n,reserve:2n,payoutRetryAt:200000})).toMatchObject({kind:"wait",reason:"retry"});
  });
  it("reconciles pending transactions even when disabled",()=>expect(nextCreatorBurnStep({...base,enabled:false,pending:{stage:"burn",hash:"0x123",checkAt:100001}})).toMatchObject({kind:"reconcile"}));
  it("does not send new transactions when disabled",()=>expect(nextCreatorBurnStep({...base,enabled:false,cash:1n})).toEqual({kind:"disabled"}));
  it("advances immediately following confirmations",()=>expect(creatorBurnReceiptDueAt(base.now,"confirmed")).toBe(base.now));
  it("checks pending receipts every minute",()=>expect(creatorBurnReceiptDueAt(base.now,"pending")).toBe(base.now+60000));
  it("does not recursively run an upstream sweep after a self buyback",()=>expect(nextCreatorBurnStep(base)).toMatchObject({kind:"wait",reason:"empty"}));
  it("pays historical cash after exit but does not burn",()=>{
    expect(nextCreatorBurnStep({...base,active:false,cash:1n})).toMatchObject({stage:"payout"});
    expect(nextCreatorBurnStep({...base,active:false,reserve:1n})).toMatchObject({kind:"wait"});
  });
  it("requires valuation and a reasonable gas-to-burn ratio",()=>{
    expect(nextCreatorBurnStep({...base,reserve:1n,reserveUsdMicros:1000000n,burnGasUsdMicros:0n})).toMatchObject({reason:"burn_accumulating"});
    expect(nextCreatorBurnStep({...base,reserve:1n})).toMatchObject({reason:"burn_accumulating"});
    expect(nextCreatorBurnStep({...base,reserve:1n,reserveUsdMicros:1000000n,burnGasUsdMicros:300000n})).toMatchObject({reason:"burn_accumulating"});
    expect(nextCreatorBurnStep({...base,reserve:1n,reserveUsdMicros:1000000n,burnGasUsdMicros:200000n})).toMatchObject({stage:"burn"});
  });
  it("bounds burn retries independently",()=>{
    expect(creatorBurnRetryAt(0,0)).toBe(60000);expect(creatorBurnRetryAt(0,100)).toBe(900000);
  });
  it("requires all enrollment owners to match the signing wallet",()=>{
    const wallet="0x1111111111111111111111111111111111111111";
    const state={wallet,primaryController:wallet,primaryBeneficiary:wallet,layerOwner:wallet,layerActive:false,layerExited:false};
    expect(()=>assertCreatorBurnEnrollmentOwner(state)).not.toThrow();
    for(const key of ["primaryController","primaryBeneficiary","layerOwner"] as const) expect(()=>assertCreatorBurnEnrollmentOwner({...state,[key]:"0x2222222222222222222222222222222222222222"})).toThrow();
  });
});
