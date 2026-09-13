import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation } from "./_generated/server";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { nearestYardPoint, yardPath, advanceYardPath } from "../lib/trading-agents/yard-navigation";
import { emptyZoneCounts, zoneExits, zoneGates, opposite, type YardDirection, type YardZone } from "../lib/trading-agents/yard-zones";

/** Server-owned scenery state. No public write endpoint and no wallet/AI operations. */
export const tick = internalMutation({
  args: { cursor: v.optional(v.string()), at: v.optional(v.number()), counts: v.optional(v.object({ center: v.number(), north: v.number(), east: v.number(), south: v.number(), west: v.number() })) },
  handler: async (ctx, args) => {
    if (!tradingAgentCapabilities().website) return;
    const at = args.at ?? Math.floor(Date.now() / 10000) * 10000;
    const counts = args.counts ?? emptyZoneCounts();
    const page = await ctx.db.query("tradingAgents").withIndex("by_created").paginate({ cursor: args.cursor ?? null, numItems: 64 });
    for (const bot of page.page) {
      if (!bot.sprite) continue;
      if ((bot.yardPosition?.at ?? 0) >= at) { counts[bot.yardPosition?.zone ?? "center"]++; continue; }
      const seed = (bot.sprite.seed ^ Math.floor(at / 10000)) >>> 0;
      const old = bot.yardPosition;
      let zone: YardZone = old?.zone ?? "center";
      let start = nearestYardPoint(old ?? { x: 30 + bot.sprite.seed % 40, y: 40 + bot.sprite.seed % 20 }, zone);
      const arrived = !old || Math.hypot(start.x - old.goalX, start.y - old.goalY) < 3;
      let exitDirection = old?.exitDirection;
      if (arrived && exitDirection) {
        const destination = zoneExits(zone)[exitDirection];
        if (destination) { zone = destination; start = nearestYardPoint(zoneGates[opposite[exitDirection]], zone); }
        exitDirection = undefined;
      } else if (arrived && seed % 4 === 0) {
        const exits = Object.keys(zoneExits(zone)) as YardDirection[];
        exitDirection = exits[(seed >>> 5) % exits.length];
      }
      const goal = arrived ? exitDirection ? zoneGates[exitDirection] : nearestYardPoint({ x: 8 + seed % 85, y: 18 + ((seed >>> 8) % 73) }, zone) : { x: old.goalX, y: old.goalY };
      const point = old ? advanceYardPath(yardPath(start, goal, zone), 6) : start;
      await ctx.db.patch(bot._id, { yardPosition: { ...point, at, goalX: goal.x, goalY: goal.y, zone, ...(exitDirection ? { exitDirection } : {}) } });
      counts[zone]++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("tradingAgentPositions:tick"), { cursor: page.continueCursor, at, counts });
    else {
      const old = await ctx.db.query("tradingAgentYardCounts").withIndex("by_key", q => q.eq("key", "yard")).unique();
      if (old && old.at <= at) await ctx.db.patch(old._id, { ...counts, at });
      else if (!old) await ctx.db.insert("tradingAgentYardCounts", { key: "yard", at, ...counts });
    }
  },
});
