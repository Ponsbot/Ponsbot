import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";
import { parseXWalletIntent } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const scenarios = [
  { post: "Launch ‘Rain Check’ as $RAIN; pair against AAPL; dev buy $12 of AAPL", expected: { name: "Rain Check", symbol: "RAIN", pairToken: "AAPL", devBuy: { amount: "12", unit: "usd" } } },
  { post: 'Launch "Velvet Morning" ticker $VELVET website velvetmorning.xyz', expected: { name: "Velvet Morning", symbol: "VELVET", website: "https://velvetmorning.xyz" } },
  { post: "deploy Quiet Signal symbol $QUIET — X @quietsignal — TG @quietsignalchat", expected: { name: "Quiet Signal", symbol: "QUIET", twitter: "https://x.com/quietsignal", telegram: "https://t.me/quietsignalchat" } },
  { post: "Create a token named Glass Garden, ticker $GLASS\nWebsite: https://glass.garden\nX: https://x.com/glassgarden", expected: { name: "Glass Garden", symbol: "GLASS", website: "https://glass.garden", twitter: "https://x.com/glassgarden" } },
  { post: "launch ‘After Midnight’ as $LATE, description ‘for traders who never sleep’", expected: { name: "After Midnight", symbol: "LATE", description: "for traders who never sleep" } },
  { post: "New token: Paper Boat / $BOAT | pair with SNDK | dev buy 3 SNDK", expected: { name: "Paper Boat", symbol: "BOAT", pairToken: "SNDK", devBuy: { amount: "3", unit: "pair" } } },
  { post: "Ticker $ORBIT, name Orbit Club. Launch it with website orbit.club and Telegram https://t.me/orbitclub", expected: { name: "Orbit Club", symbol: "ORBIT", website: "https://orbit.club", telegram: "https://t.me/orbitclub" } },
  { post: "Launch North Window ticker NWND pair it with MSFT dev buy $25 of MSFT X @northwindow", expected: { name: "North Window", symbol: "NWND", pairToken: "MSFT", devBuy: { amount: "25", unit: "usd" }, twitter: "https://x.com/northwindow" } },
  { post: "make me a token called Soft Landing using $SOFT as the ticker; site softlanding.io; description \"a gentler landing\"", expected: { name: "Soft Landing", symbol: "SOFT", website: "https://softlanding.io", description: "a gentler landing" } },
  { post: "Launch 'No Links Needed' ticker $NLN", expected: { name: "No Links Needed", symbol: "NLN" } },
  { post: "launch Broken Social ticker $BROKE website: X: @broken", expected: { name: "Broken Social", symbol: "BROKE", twitter: "https://x.com/broken" } },
  { post: "launch Solar Tape ticker $TAPE pair against ETH dev buy 0.004 ETH", expected: { name: "Solar Tape", symbol: "TAPE", pairToken: "ETH", devBuy: { amount: "0.004", unit: "eth" } } },
] as const;

describe.runIf(process.env.LIVE_AI_TESTS === "true")("live AI launch format variations", () => {
  it("extracts varied launch combinations without executing them", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const selected = process.env.LAUNCH_AI_FILTER ? scenarios.filter((scenario) => scenario.post.includes(process.env.LAUNCH_AI_FILTER!)) : scenarios;
    const results: unknown[] = [];
    const failures: unknown[] = [];
    for (let offset = 0; offset < selected.length; offset += 3) {
      const batch = selected.slice(offset, offset + 3);
      const intents = await Promise.all(batch.map(({ post }) => parseXWalletIntent(post, false)));
      intents.forEach((intent, index) => {
        const scenario = batch[index];
        const extracted = intent.kind === "command" && intent.command.kind === "launch" ? intent.command as unknown as Record<string, unknown> : null;
        const pass = Boolean(extracted && Object.entries(scenario.expected).every(([key, value]) => JSON.stringify(extracted[key]) === JSON.stringify(value)));
        const result = { post: scenario.post, expected: scenario.expected, intent, pass };
        results.push(result);
        if (!pass) failures.push(result);
      });
    }
    console.log(`LIVE_LAUNCH_VARIATIONS=${JSON.stringify(results)}`);
    expect(failures).toEqual([]);
  }, 240_000);
});
