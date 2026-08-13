import { loadEnvConfig } from "@next/env";
import { expect, it, vi } from "vitest";
import { parseXWalletIntent } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());
const post = 'Hey @ponsbotfamily, launch "Pons Bot", ticker "PONSBOT", X: www.x.com/ponsbotfamily, website: www.ponsbot.family, dev buy: $100, description "Swap, send, and launch on Pons V2 with just one X post."';

it("runs the exact launch through live AI twenty times", async () => {
  expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
  const errorSpy = vi.spyOn(console, "error");
  const results = [];
  for (let run = 1; run <= 20; run += 1) {
    errorSpy.mockClear();
    const intent = await parseXWalletIntent(post, false);
    const validationFailures = errorSpy.mock.calls.filter(([event]) => event === "x_command_parameter_validation_failed").length;
    const extractionFailures = errorSpy.mock.calls.filter(([event]) => event === "x_command_parameter_extraction_failed").length;
    const usedFallback = validationFailures > 0 || extractionFailures > 0;
    const result = { run, intent, usedFallback, validationFailures, extractionFailures };
    results.push(result);
    console.log(`TWENTY_LAUNCH_RUN_${run}=${JSON.stringify(result)}`);
  }
  console.log(`TWENTY_LAUNCH_RESULTS=${JSON.stringify(results)}`);
}, 600_000);
