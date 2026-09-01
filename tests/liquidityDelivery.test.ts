import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { deliverLiquidityResult } from "../convex/xReplies";
import { LIQUIDITY_TEST_OWNER } from "./liquidityFixtures";

async function check(interaction: Record<string, unknown>, options: { author?: string; owner?: string; queuedAfterRetry?: boolean } = {}) {
  const current = { interaction, user: { xUserId: options.author ?? LIQUIDITY_TEST_OWNER } };
  const ctx = {
    runQuery: vi.fn(async ref => {
      switch (getFunctionName(ref)) {
        case "liquidity:executionContext": return { execution: { ownerXUserId: options.owner ?? LIQUIDITY_TEST_OWNER, response: "Position opened" }, turn: { requestKey: "x:original" } };
        case "xReplies:getRetryContext": return current;
        default: throw new Error("Unexpected query");
      }
    }),
    runAction: vi.fn(async (ref, args) => {
      expect(getFunctionName(ref)).toBe("xReplies:retryInteraction"); expect(args).toEqual({ postId: "original" });
      if (options.queuedAfterRetry) current.interaction.publicationQueued = true;
    }),
  };
  const result = await (deliverLiquidityResult as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<boolean> })._handler(ctx, { postId: "original", executionId: "execution" });
  return { result, ctx };
}

describe("liquidity final X delivery handoff (no X calls)", () => {
  it.each([
    { status: "rejected", safeError: "operator_cancelled" }, { status: "completed" },
    { status: "publishing" }, { status: "processing", publicationQueued: true },
    { status: "processing", responsePostId: "already-published" },
  ])("never revives a terminal interaction or duplicates an existing publication: %j", async interaction => {
    const { result, ctx } = await check(interaction);
    expect(result).toBe(true); expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it("does not mistake a no-op retry (such as disabled replies) for delivery", async () => {
    const { result, ctx } = await check({ status: "processing" });
    expect(result).toBe(false); expect(ctx.runAction).toHaveBeenCalledTimes(1);
  });
  it("accepts a durable queue handoff without posting directly", async () => {
    const { result } = await check({ status: "processing" }, { queuedAfterRetry: true });
    expect(result).toBe(true);
  });
  it.each([{ author: "another-user" }, { owner: "another-user" }])("rejects another owner: %j", async options => {
    const { result, ctx } = await check({ status: "processing" }, options);
    expect(result).toBe(false); expect(ctx.runAction).not.toHaveBeenCalled();
  });
});
