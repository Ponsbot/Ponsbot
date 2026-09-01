import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { getAddress, keccak256, stringToHex } from "viem";

const configuredTokens = [...new Set((process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean))];
if (configuredTokens.length !== 1) throw new Error("exactly one manual test token must be configured");
const TOKEN = getAddress(configuredTokens[0]);
const VAULT = getAddress(process.env.AUTOMATED_FEE_MANUAL_TEST_VAULT_ADDRESS ?? "");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmationIndex = args.indexOf("--confirm");
const suppliedConfirmation = confirmationIndex >= 0 ? args[confirmationIndex + 1] : "";
const confirmationToken = keccak256(stringToHex(["PONSBOT_UTEST_COMBINED_CYCLE_V1", 4663, TOKEN, VAULT].join(":")));

function run(script, scriptArgs = []) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--use-system-ca", "--env-file-if-exists=.env.local", resolve("scripts", script), ...scriptArgs], {
      cwd: process.cwd(), env: process.env, windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${script} failed: ${stderr || stdout}`));
      try { resolveRun(JSON.parse(stdout.trim())); } catch { reject(new Error(`${script} returned invalid JSON: ${stdout}`)); }
    });
  });
}

const inspection = await run("inspect-automated-fee-test-cycle.mjs");
if (!execute) {
  console.log(JSON.stringify({
    mode: "read_only_combined_utest_fee_cycle",
    mutationSent: false,
    confirmationToken,
    token: TOKEN,
    vault: VAULT,
    currentEscrowBalanceWei: inspection.escrowBalanceWei,
    currentCreatorClaimableWei: inspection.controllerClaimableWei,
    lastCurveSweepBlock: inspection.lastCurveSweepBlock,
    steps: ["sweep bonding-curve fees", "claim and process exact 95/5 split", "buy and burn PONSBOT", "deliver all creator allocation"],
  }, null, 2));
} else {
  if (suppliedConfirmation.toLowerCase() !== confirmationToken.toLowerCase()) throw new Error("combined UTEST cycle requires the exact dry-run confirmation token");
  let sweep = null;
  if (inspection.lastCurveSweepBlock === "0") {
    sweep = await run("sweep-automated-fee-test-cycle.mjs", ["--execute", "--confirm", "0x28cd3246d40ab0edf14ccfb73c8979fa0c46167b5d7239b6952ab9dfee4f1075"]);
  }
  let processing = null;
  const processingPlanAttempt = await run("process-automated-fee-test-cycle.mjs").catch((error) => ({ error: error.message }));
  if (!processingPlanAttempt.error) {
    processing = await run("process-automated-fee-test-cycle.mjs", ["--execute", "--confirm", processingPlanAttempt.confirmationToken]);
  }
  const deliveryPlan = await run("deliver-automated-fee-test-allocation.mjs");
  let delivery = deliveryPlan;
  if (deliveryPlan.confirmationToken) {
    delivery = await run("deliver-automated-fee-test-allocation.mjs", ["--execute", "--confirm", deliveryPlan.confirmationToken]);
  }
  const final = await run("inspect-automated-fee-test-cycle.mjs");
  console.log(JSON.stringify({
    status: processing ? "combined_utest_fee_cycle_completed" : "combined_utest_cycle_no_new_processable_fees",
    mutationSent: Boolean(sweep?.mutationSent || processing?.mutationSent || delivery?.mutationSent),
    sweep,
    processing: processing ?? processingPlanAttempt,
    delivery,
    finalState: final,
  }, null, 2));
}
