import { describe, expect, it, vi } from "vitest";
import { parseContextualBuy, resolveContextualBuyToken } from "../lib/contextual-buy";
import { shouldHandlePassiveChainText, contextualBuyParent } from "../convex/xReplies";
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
describe("contextual X buys", () => {
  it.each(["buy $20 of this", "@Ponsbotfamily buy $20 of that token!", "Please buy $20 of this please."])("accepts %s", text => {
    expect(parseContextualBuy(text)).toEqual({amount:"20",unit:"usd"});
    expect(shouldHandlePassiveChainText(text)).toBe(true);
  });
  it("accepts explicit ETH amounts", () => expect(parseContextualBuy("buy 0.01 ETH of this")).toEqual({amount:"0.01",unit:"eth"}));
  it.each(["buy this", "don't buy $20 of this", 'say "buy $20 of this"', "buy $20 of this and send to @alice", "buy $0 of this"])("rejects %s", text => expect(parseContextualBuy(text)).toBeUndefined());
  it("uses a single CA even when the parent mentions pairing tickers", async () => {
    const resolve=vi.fn(); expect(await resolveContextualBuyToken(`${a} paired with $USDG`, resolve)).toBe(a); expect(resolve).not.toHaveBeenCalled();
  });
  it("deduplicates repeated CAs and ticker aliases", async () => {
    expect(await resolveContextualBuyToken(`${a} ${a}`, vi.fn())).toBe(a);
    expect(await resolveContextualBuyToken("$ABC $abc", async()=>a)).toBe(a);
  });
  it("requires a dollar sign for indexed tickers", async () => {
    expect(await resolveContextualBuyToken("check out $ponsbot", async t=>t==='PONSBOT'?a:t)).toBe(a);
    await expect(resolveContextualBuyToken("check out ponsbot", async()=>a)).rejects.toThrow("NOT_FOUND");
  });
  it("rejects multiple addresses, multiple indexed tickers and duplicate symbols", async () => {
    await expect(resolveContextualBuyToken(`${a} ${b}`, vi.fn())).rejects.toThrow("AMBIGUOUS");
    await expect(resolveContextualBuyToken("$ABC $DEF", async t=>t==='ABC'?a:b)).rejects.toThrow("AMBIGUOUS");
    await expect(resolveContextualBuyToken("$ABC", async()=>{throw Error("that ticker matches more than one token");})).rejects.toThrow("AMBIGUOUS");
  });
  it("never uses an unindexed ticker or handles as a token", async () => {
    await expect(resolveContextualBuyToken("@Ponsbotfamily $NOTINDEXED", async t=>t)).rejects.toThrow("NOT_FOUND");
  });
});

describe("direct launch confirmation mapping", () => {
  function context(rows: Record<string, any[]>) {
    return { db: { query: (table: string) => {
      let selected = rows[table] || [];
      const q: any = { withIndex: (_name: string, callback: any) => {
        const filter = {eq: (key: string, value: unknown) => { selected = selected.filter(r=>r[key]===value); return filter; }};
        callback(filter); return q;
      }, unique: async()=>selected[0] || null, collect: async()=>selected };
      return q;
    } } };
  }
  it("maps the bot's exact confirmation to the confirmed launch, not its paired ticker", async () => {
    const ctx=context({xReplyInteractions:[{postId:"original",responsePostId:"confirmation",status:"completed",text:"launch Example $ABC paired with $USDG"}],walletRequests:[{sourcePostId:"original",requestId:"launch-id",kind:"launch",status:"confirmed"}],tokenLaunches:[{requestId:"launch-id",tokenAddress:a,publicPublished:true}]});
    expect(await (contextualBuyParent as any)._handler(ctx,{postId:"confirmation"})).toEqual({token:a});
    expect(await (contextualBuyParent as any)._handler(ctx,{postId:"different-reply"})).toEqual({});
  });
  it("does not inherit a token from an earlier post or failed launch", async () => {
    const ctx=context({xReplyInteractions:[{postId:"original",responsePostId:"failure",status:"completed",text:"$ABC"},{postId:"child",parentPostId:"original",text:"hello"}],walletRequests:[{sourcePostId:"original",kind:"launch",status:"failed"}]});
    expect(await (contextualBuyParent as any)._handler(ctx,{postId:"failure"})).toEqual({});
    expect(await (contextualBuyParent as any)._handler(ctx,{postId:"child"})).toEqual({text:"hello"});
  });
});
