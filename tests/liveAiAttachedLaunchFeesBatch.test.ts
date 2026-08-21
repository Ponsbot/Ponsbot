import { loadEnvConfig } from "@next/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWalletCommand } from "../convex/walletCommands";
import { parseXWalletIntentWithDiagnostics } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

const sourcePath = process.env.ATTACHED_LAUNCH_AI_FILE;
const outputPath = process.env.ATTACHED_LAUNCH_AI_OUTPUT;

function prompts() {
  const text = readFileSync(sourcePath!, "utf8").replace(/\r/g, "");
  const matches = [...text.matchAll(/(?:^|\n)(\d+)\.\s+([\s\S]*?)(?=\n\s*\n(?:\d+\.|###)|$)/g)];
  return matches.map((match) => ({ id: Number(match[1]), post: match[2].trim() }));
}

describe.runIf(process.env.LIVE_AI_TESTS === "true" && Boolean(sourcePath))("attached live AI launch and fee batch", () => {
  it("runs every numbered prompt through OpenRouter without X or wallet execution", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    const inputs = prompts();
    expect(inputs).toHaveLength(100);
    const results: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < inputs.length; offset += 4) {
      const batch = inputs.slice(offset, offset + 4);
      const parsed = await Promise.all(batch.map((item) => parseXWalletIntentWithDiagnostics(item.post, /attached|artwork|image/i.test(item.post))));
      parsed.forEach(({ intent, diagnostics }, index) => {
        const item = batch[index];
        const grounded = parseWalletCommand(item.post);
        const command = intent.kind === "command" ? intent.command : undefined;
        const aiLaunch = command?.kind === "launch" ? command : undefined;
        const expectedLaunch = grounded.kind === "launch" ? grounded : undefined;
        const fieldIssues: string[] = [];
        if (aiLaunch && expectedLaunch) {
          for (const key of ["name", "symbol", "description", "website", "twitter", "telegram", "pairToken", "feeRecipient", "holderFeeSharing", "devBuy"] as const) {
            if (JSON.stringify(aiLaunch[key]) !== JSON.stringify(expectedLaunch[key])) fieldIssues.push(`${key}: expected ${JSON.stringify(expectedLaunch[key])}, got ${JSON.stringify(aiLaunch[key])}`);
          }
        }
        const conflict = /assign fees to[\s\S]*holder fee sharing|holder fee sharing[\s\S]*assign fees to/i.test(item.post);
        const alternateFeeWording = item.id >= 63 && item.id <= 72;
        const wronglyActivatedFeeOption = alternateFeeWording && Boolean(aiLaunch?.feeRecipient || aiLaunch?.holderFeeSharing);
        results.push({
          ...item, intent, diagnostics, grounded,
          launchRecognized: Boolean(aiLaunch), conflict, alternateFeeWording, wronglyActivatedFeeOption, fieldIssues,
          fallback: diagnostics.source === "deterministic_fallback" || diagnostics.source === "deterministic_guard",
          retry: diagnostics.classificationAttempts.length > 1 || diagnostics.extractionAttempts.length > 1,
        });
      });
    }
    const summary = {
      total: results.length,
      launchRecognized: results.filter((item) => item.launchRecognized).length,
      rejected: results.filter((item) => !item.launchRecognized).length,
      fallbacks: results.filter((item) => item.fallback).length,
      retries: results.filter((item) => item.retry).length,
      fieldFailures: results.filter((item) => (item.fieldIssues as string[]).length > 0).length,
      wronglyActivatedFeeOptions: results.filter((item) => item.wronglyActivatedFeeOption).length,
    };
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2));
    }
    console.log(`ATTACHED_LAUNCH_AI_SUMMARY=${JSON.stringify(summary)}`);
  }, 900_000);
});
