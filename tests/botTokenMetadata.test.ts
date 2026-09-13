import {expect,it,vi} from "vitest";
import {botTokenMetadata} from "../convex/lib/botTokenMetadata";
import {botAsset} from "../lib/trading-agents/display";
const address="0x594d9c6a9352fe304ba00ec18146252601b1cb07";
function fixture(registry:unknown,launch:unknown){
  const query=vi.fn((table:string)=>({withIndex:()=>({first:async()=>table==="tokenRegistry"?registry:launch})}));
  return {ctx:{db:{query}} as unknown as Parameters<typeof botTokenMetadata>[0],query};
}
it("formats PONSBOY from the launch index when registry metadata is absent",async()=>{
  const {ctx}=fixture(null,{tokenAddress:address,symbol:"PONSBOY"});
  const metadata=await botTokenMetadata(ctx,address.toUpperCase());
  expect(metadata).toEqual({symbol:"PONSBOY",decimals:18});
  expect(botAsset({token:address,amount:"2699728734643716958576283",...metadata!,usdValue:13.79})).toBe("2,699,700 PONSBOY ($13.79)");
});
it("preserves registry decimals for assets that are not 18 decimals",async()=>{
  const {ctx,query}=fixture({symbol:"ASSET",decimals:6},null);
  expect(await botTokenMetadata(ctx,address)).toEqual({symbol:"ASSET",decimals:6});
  expect(query).toHaveBeenCalledTimes(1);
});
it("does not invent metadata for unknown addresses",async()=>{
  expect(await botTokenMetadata(fixture(null,null).ctx,address)).toBeNull();
});
