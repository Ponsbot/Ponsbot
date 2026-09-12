import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("trading-agent rollout isolation", () => {
  it("keeps writes internal and gates the sole public presentation query", () => {
    const source = readFileSync("convex/tradingAgents.ts", "utf8");
    expect(source).not.toMatch(/export const \w+\s*=\s*(action|mutation)\(/);
    expect(source.match(/export const \w+\s*=\s*query\(/g)).toEqual(["export const publicYard = query("]);
    expect(source).toContain("if (!tradingAgentCapabilities().website) return { bots: [], nextCursor: null }");
    expect(source).not.toMatch(/ctx\.scheduler|runAfter\(|runAt\(/);
  });
  it("registers only an explicitly gated worker tick", () => {
    expect(readFileSync("convex/crons.ts", "utf8")).toContain("tradingAgentRuntime:tick");
    const runtime = readFileSync("convex/tradingAgentRuntime.ts", "utf8");
    expect(runtime).toContain("if (!tradingAgentCapabilities().scheduler || !tradingAgentCapabilities().paperTrading) return");
  });
  it("contains no live signing or wallet provisioning imports", () => {
    const sources = readdirSync("lib/trading-agents").filter(f => f.endsWith(".ts"))
      .map(f => readFileSync(join("lib/trading-agents", f), "utf8")).join("\n");
    expect(sources).not.toMatch(/from ["'][^"']*(?:wallet-signer|cdp-sdk|viem\/accounts)/);
    expect(sources).not.toMatch(/signTransaction\(|signHash\(|sendRawTransaction\(|createAccount\(/);
  });
});
