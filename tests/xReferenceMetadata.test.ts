import { expect, it, vi } from "vitest";
import { loadReplyMetadata, type ReferencePost } from "../lib/x-reference-metadata";
import { includedReplyDepth, isReplyToReply } from "../convex/xReplies";
const reply=(id:string,parent:string):ReferencePost=>({id,referenced_tweets:[{id:parent,type:"replied_to"}]});
it("does not fetch quoted posts, root posts or ignored reply chatter",async()=>{
 const get=vi.fn(),fetch=vi.fn();
 await loadReplyMetadata([{id:"1"},{id:"2",referenced_tweets:[{id:"quote",type:"quoted"}]},reply("3","parent")],new Set(["1","2"]),get,fetch);
 expect(get).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it("reuses persisted depth including zero and parents already in the mentions page",async()=>{
 const fetch=vi.fn();const posts=[reply("1","p"),reply("2","q"),reply("3","r"),{id:"r"}];
 const result=await loadReplyMetadata(posts,new Set(["1","2","3"]),async id=>id==="p"?6:id==="q"?0:undefined,fetch);
 expect(fetch).not.toHaveBeenCalled();expect(result.depths.get("p")).toBe(6);expect(result.references.has("r")).toBe(true);
});
it("deduplicates and batches unknown immediate parents without requesting their ancestors",async()=>{
 const fetch=vi.fn(async ids=>ids.map((id:string)=>reply(id,"ancestor")));
 const get=vi.fn(async()=>undefined),posts=[reply("1","p"),reply("2","p"),reply("3","q")];
 const result=await loadReplyMetadata(posts,new Set(["1","2","3"]),get,fetch);
 expect(get).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledExactlyOnceWith(["p","q"]);
 expect(isReplyToReply(posts[0],result.references)).toBe(true);
 expect(includedReplyDepth(posts[0],result.references)).toBe(2);
});
it("retains fetched parent authors for bot-parent authorization",async()=>{
 const result=await loadReplyMetadata([reply("1","bot-post")],new Set(["1"]),async()=>undefined,async()=>[
  {id:"bot-post",author_id:"12345"},
 ]);
 expect(result.references.get("bot-post")?.author_id).toBe("12345");
});
it("propagates temporary lookup failures so polling does not advance its cursor",async()=>{
 await expect(loadReplyMetadata([reply("1","p")],new Set(["1"]),async()=>undefined,async()=>{throw Error("429")})).rejects.toThrow("429");
});
it("tolerates omitted deleted parents and never imports unrelated response data",async()=>{
 const result=await loadReplyMetadata([reply("1","p")],new Set(["1"]),async()=>undefined,async()=>[{id:"unrelated"}]);
 expect(result.references.has("p")).toBe(false);expect(result.references.has("unrelated")).toBe(false);
});
