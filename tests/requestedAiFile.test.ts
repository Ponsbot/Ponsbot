import { loadEnvConfig } from "@next/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseXWalletIntentWithDiagnostics } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const sourcePath = process.env.REQUESTED_AI_FILE;
const outputPath = process.env.REQUESTED_AI_OUTPUT;
const operations: Record<string, string> = {
  Buy: "buy", Sell: "sell", Send: "send", "Buy and send": "buy_and_send",
  Burn: "burn", "Buy and burn": "buy_and_burn", "Creator fees": "claim_fees",
  Launches: "launch", "Wallet and holdings": "wallet_or_balance", "Questions and help": "help",
};

function scenarios() {
  const result: Array<{ id: number; section: string; post: string; expectedOperation: string; hasImage: boolean }> = [];
  let section = "";
  for (const raw of readFileSync(sourcePath!, "utf8").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^##\s+(.+)$/)?.[1];
    if (heading) { section = heading; continue; }
    const numbered = line.match(/^(\d+)\.\s+(.+)$/);
    if (!numbered || !operations[section]) continue;
    result.push({
      id: Number(numbered[1]), section, post: numbered[2], expectedOperation: operations[section],
      hasImage: /attached\s+(?:image|art|artwork)|attached\s+artwork/i.test(numbered[2]),
    });
  }
  return result;
}

function requiredFieldIssues(command: Record<string, unknown>) {
  const issues: string[] = [];
  const kind = String(command.kind || "");
  if (["buy", "sell", "send", "burn", "buy_and_send", "buy_and_burn"].includes(kind) && !command.amount) issues.push("missing amount");
  if (["buy", "sell", "burn", "buy_and_send", "buy_and_burn"].includes(kind) && !command.token) issues.push("missing token");
  if (["send", "buy_and_send"].includes(kind) && !command.recipient) issues.push("missing recipient");
  if (kind === "launch" && (!command.name || !command.symbol)) issues.push("missing launch name/ticker");
  return issues;
}

describe.runIf(process.env.LIVE_AI_TESTS === "true" && Boolean(sourcePath))("requested live AI-file audit", () => {
  it("runs each prompt through AI parsing without X or wallet execution", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const inputs = scenarios();
    expect(inputs.length).toBeGreaterThan(0);
    const results: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < inputs.length; offset += 4) {
      const batch = inputs.slice(offset, offset + 4);
      const parsed = await Promise.all(batch.map((item) => parseXWalletIntentWithDiagnostics(item.post, item.hasImage)));
      parsed.forEach(({ intent, diagnostics }, index) => {
        const item = batch[index];
        const actualOperation = intent.kind === "command" ? intent.command.kind : intent.kind;
        const operationPass = item.expectedOperation === "wallet_or_balance"
          ? actualOperation === "show_wallet" || actualOperation === "show_balance"
          : item.expectedOperation === "help" ? intent.kind === "help" : actualOperation === item.expectedOperation;
        const requiredIssues = intent.kind === "command" ? requiredFieldIssues(intent.command as unknown as Record<string, unknown>) : [];
        const fallback = diagnostics.source === "deterministic_fallback" || diagnostics.source === "deterministic_guard";
        const retry = diagnostics.classificationAttempts.length > 1 || diagnostics.extractionAttempts.length > 1;
        results.push({ ...item, intent, diagnostics, actualOperation, operationPass, rejected: intent.kind === "unknown_wallet", fallback, retry, requiredIssues });
      });
    }
    const nonClean = results.filter((item) => !item.operationPass || item.fallback || item.retry || (item.requiredIssues as string[]).length);
    const summary = {
      total: results.length,
      operationPass: results.filter((item) => item.operationPass).length,
      rejected: results.filter((item) => item.rejected).length,
      fallbacks: results.filter((item) => item.fallback).length,
      retries: results.filter((item) => item.retry).length,
      nonClean: nonClean.length,
    };
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify({ summary, results, nonClean }, null, 2));
    }
    console.log(`REQUESTED_AI_FILE_SUMMARY=${JSON.stringify(summary)}`);
  }, 2_400_000);
});
