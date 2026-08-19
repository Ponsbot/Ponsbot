import { loadEnvConfig } from "@next/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseXWalletIntentWithDiagnostics } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const sourcePath = process.env.REQUESTED_300_AI_FILE;
const outputPath = process.env.REQUESTED_300_AI_OUTPUT;
const operations: Record<string, string> = {
  "Buy requests": "buy",
  "Sell requests": "sell",
  "Send requests": "send",
  "Buy and send": "buy_and_send",
  "Burn requests": "burn",
  "Buy and burn": "buy_and_burn",
  "Creator-fee claims": "claim_fees",
  "Token launches": "launch",
  "Wallet and balance requests": "wallet_or_balance",
};
// These cases are deliberately outside the supported public syntax and are not
// part of this regression suite:
// - X recipients must be written as @handles, not bare usernames.
// - Telegram launch links must be t.me URLs, not @handles.
const excludedCases = new Set([
  98, 101, 103, 105, 107, 109, 111, 113, 115, 117, 125, 127, 128, 129, 131, 132, 134,
  137, 139, 141, 143, 145, 147, 149, 151, 153, 155, 157, 159,
  263, 265, 270, 272, 276, 280,
]);
const expectedPolicyRejections = new Set([148, 150]);

function scenarios() {
  const result: Array<{ id: number; section: string; post: string; expectedOperation: string; hasImage: boolean; expectedPolicyRejection: boolean }> = [];
  let section = "";
  for (const raw of readFileSync(sourcePath!, "utf8").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^##\s+(.+)$/)?.[1];
    if (heading) { section = heading; continue; }
    const numbered = line.match(/^(\d+)\.\s+(.+)$/);
    if (!numbered || !operations[section]) continue;
    const id = Number(numbered[1]);
    if (excludedCases.has(id)) continue;
    result.push({
      id, section, post: numbered[2], expectedOperation: operations[section],
      hasImage: /attached\s+(?:image|art|artwork)|attached\s+artwork/i.test(numbered[2]),
      expectedPolicyRejection: expectedPolicyRejections.has(id),
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
  if (kind === "swap_token_for_token" && (!command.fromToken || !command.toToken)) issues.push("missing swap token");
  return issues;
}

describe.runIf(process.env.LIVE_AI_TESTS === "true" && Boolean(sourcePath))("requested 300-prompt live Luna audit", () => {
  it("runs every prompt through AI parsing without X or wallet execution", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const inputs = scenarios();
    expect(inputs).toHaveLength(265);
    const results: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < inputs.length; offset += 4) {
      const batch = inputs.slice(offset, offset + 4);
      const parsed = await Promise.all(batch.map((item) => parseXWalletIntentWithDiagnostics(item.post, item.hasImage)));
      parsed.forEach(({ intent, diagnostics }, index) => {
        const item = batch[index];
        const actualOperation = intent.kind === "command" ? intent.command.kind : undefined;
        const requiredIssues = intent.kind === "command" ? requiredFieldIssues(intent.command as unknown as Record<string, unknown>) : [];
        const operationPass = item.expectedOperation === "wallet_or_balance"
          ? actualOperation === "show_wallet" || actualOperation === "show_balance"
          : actualOperation === item.expectedOperation;
        const rejected = intent.kind !== "command";
        const fallback = diagnostics.source === "deterministic_fallback" || diagnostics.source === "deterministic_guard";
        const retry = diagnostics.classificationAttempts.length > 1 || diagnostics.extractionAttempts.length > 1;
        results.push({ ...item, intent, diagnostics, actualOperation, operationPass, rejected, fallback, retry, requiredIssues });
      });
    }
    const nonClean = results.filter((item) => !item.operationPass || item.fallback || item.retry || (item.requiredIssues as string[]).length);
    const summary = {
      total: results.length,
      operationPass: results.filter((item) => item.operationPass).length,
      rejected: results.filter((item) => item.rejected).length,
      expectedPolicyRejected: results.filter((item) => item.rejected && item.expectedPolicyRejection).length,
      fallbacks: results.filter((item) => item.fallback).length,
      retries: results.filter((item) => item.retry).length,
      nonClean: nonClean.length,
    };
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify({ summary, results, nonClean }, null, 2));
    }
    console.log(`REQUESTED_300_AI_SUMMARY=${JSON.stringify(summary)}`);
  }, 2_400_000);
});
