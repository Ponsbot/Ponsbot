import { readFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";
import { parseXWalletIntent } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const sourcePath = process.env.ATTACHED_LAUNCH_FILE;

function launchBlocks(source: string) {
  const lines = source.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const begins = /^(?:launch\b|launch\s+token\b|create\b|deploy\b|new\s+(?:launch|token|one)\b|i\s+(?:want|need)\b|need\b|can\b|pons\b|token\s*:|token\s+(?:launch|request|name)\b|pls\b|make\b|name\b|ticker\b|\$[A-Z]|attached\b|use\s+the\s+image|hey\s+pons|@ponsbot|“[^”]+”|'[^']+'|NAME:|TOKEN LAUNCH REQUEST)/i;
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const starts = begins.test(line);
    const currentLooksComplete = current.some((item) => /\b(?:ticker|symbol)\b|\$[A-Z0-9]{2,}/i.test(item));
    const forceContinuation = /^(?:ticker|symbol|description|pair|pairing asset|website|x|telegram|dev(?:eloper)? buy|go|launch(?: it| please)?\.?$)/i.test(line);
    if (starts && current.length && currentLooksComplete && !forceContinuation) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

describe("attached launch batch segmentation", () => {
  it("does not merge a completed launch with a following Token or Name block", () => {
    const source = `launch Autonomous Toaster ticker TOAST
Token: Chairman Meow
Ticker: MEOW
Launch it
launch First Token ticker FIRST
Name “Meeting Could Be Email”
Ticker $EMAIL
Launch please`;
    const blocks = launchBlocks(source);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toContain("Autonomous Toaster");
    expect(blocks[1]).toContain("Chairman Meow");
    expect(blocks[2]).toContain("First Token");
    expect(blocks[3]).toContain("Meeting Could Be Email");
  });
});

describe.runIf(process.env.LIVE_AI_TESTS === "true" && Boolean(sourcePath))("attached launch batch through live AI", () => {
  it("classifies and extracts without X, wallet, or launch execution", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const allPosts = launchBlocks(readFileSync(sourcePath!, "utf8"));
    const filters = process.env.ATTACHED_LAUNCH_FILTER?.split("|").filter(Boolean);
    const posts = filters?.length ? allPosts.filter((post) => filters.some((filter) => post.includes(filter))) : allPosts;
    const results: unknown[] = [];
    for (let offset = 0; offset < posts.length; offset += 4) {
      const batch = posts.slice(offset, offset + 4);
      const intents = await Promise.all(batch.map((post) => parseXWalletIntent(`@Ponsbotfamily ${post}`, /attach(?:ed|ment)|\bartwork\b|\bimage\b|\blogo\b|\bpic\b/i.test(post))));
      intents.forEach((intent, index) => results.push({ number: offset + index + 1, post: batch[index], intent, validLaunch: intent.kind === "command" && intent.command.kind === "launch" }));
    }
    console.log(`ATTACHED_LAUNCH_BATCH=${JSON.stringify({ count: posts.length, results })}`);
    expect(posts.length).toBeGreaterThan(0);
  }, 600_000);
});
