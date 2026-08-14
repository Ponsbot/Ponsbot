import { loadEnvConfig } from "@next/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseXWalletIntent } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const sourcePath = process.env.ATTACHED_FULL_AI_FILE;
const outputPath = process.env.ATTACHED_FULL_AI_OUTPUT;
const headings: Record<string, { kind: "command" | "help" | "unknown_wallet"; operation?: string }> = {
  "Wallets and balances": { kind: "command", operation: "wallet_or_balance" },
  Buying: { kind: "command", operation: "buy" }, Selling: { kind: "command", operation: "sell" },
  Sending: { kind: "command", operation: "send" }, "Buy and send": { kind: "command", operation: "buy_and_send" },
  Burning: { kind: "command", operation: "burn" }, "Burn wording that should NOT trigger": { kind: "unknown_wallet" },
  "Buy and burn": { kind: "command", operation: "buy_and_burn" }, "Creator fees": { kind: "command", operation: "claim_fees" },
  Launches: { kind: "command", operation: "launch" }, "Questions and conversational wording": { kind: "help" },
  "Ambiguous and wording-focused edge cases": { kind: "unknown_wallet" },
};

function cases() {
  const rows: Array<{ section: string; post: string; expected: (typeof headings)[string]; hasImage: boolean }> = [];
  let section = "";
  for (const raw of readFileSync(sourcePath!, "utf8").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (headings[line]) { section = line; continue; }
    if (!headings[section]) continue;
    rows.push({ section, post: line, expected: headings[section], hasImage: /attached|artwork|image|pic/i.test(line) });
  }
  return rows;
}

function suspicious(command: Record<string, unknown>) {
  const issues: string[] = [];
  const kind = String(command.kind || "");
  if (["buy", "sell", "send", "burn", "buy_and_send", "buy_and_burn"].includes(kind) && !command.amount) issues.push("missing amount");
  if (["buy", "sell", "burn", "buy_and_send", "buy_and_burn"].includes(kind) && !command.token) issues.push("missing token");
  if (["send", "buy_and_send"].includes(kind) && !command.recipient) issues.push("missing recipient");
  if (kind === "launch" && (!command.name || !command.symbol)) issues.push("missing launch name/ticker");
  if (command.unit === "percent" && (Number(command.amount) <= 0 || Number(command.amount) > 100)) issues.push("invalid percentage");
  return issues;
}

describe.runIf(process.env.LIVE_AI_TESTS === "true" && Boolean(sourcePath))("requested full attached suite through live OpenRouter", () => {
  it("classifies and extracts every attached post without external actions", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const scenarios = cases();
    const results: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < scenarios.length; offset += 4) {
      const batch = scenarios.slice(offset, offset + 4);
      const intents = await Promise.all(batch.map((item) => parseXWalletIntent(item.post, item.hasImage)));
      intents.forEach((intent, index) => {
        const item = batch[index];
        const actualOperation = intent.kind === "command" ? intent.command.kind : undefined;
        const expectedOperation = item.expected.operation;
        const kindPass = item.expected.kind === "command" ? intent.kind === "command" : intent.kind === item.expected.kind;
        const operationPass = !expectedOperation || expectedOperation === "wallet_or_balance"
          ? !expectedOperation || actualOperation === "show_wallet" || actualOperation === "show_balance"
          : actualOperation === expectedOperation;
        const issues = intent.kind === "command" ? suspicious(intent.command as unknown as Record<string, unknown>) : [];
        results.push({ ...item, intent, pass: kindPass && operationPass && issues.length === 0, issues });
      });
    }
    const failures = results.filter((item) => !item.pass);
    if (outputPath) { mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, JSON.stringify({ results, failures }, null, 2)); }
    console.log(`REQUESTED_FULL_AI_SUMMARY=${JSON.stringify({ total: results.length, passed: results.length - failures.length, failed: failures.length })}`);
    if (failures.length) console.log(`REQUESTED_FULL_AI_FAILURES=${JSON.stringify(failures)}`);
    expect(failures.length).toBe(0);
  }, 1_200_000);
});
