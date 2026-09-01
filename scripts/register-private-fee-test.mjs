import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertPrivateFeeTestMode } from "./lib/private-fee-test-mode.mjs";

assertPrivateFeeTestMode(process.env, true);
const plan = JSON.parse(await readFile(resolve(".deployment-private/automated-fee-production-test-plan.json"), "utf8"));
const state = JSON.parse(await readFile(resolve(".deployment-private/automated-fee-production-test-state.json"), "utf8"));
if (plan.workflow !== "private_scheduled_engine_test" || state.confirmationToken !== plan.confirmationToken
  || state.launch.status !== "confirmed" || state.vault.status !== "confirmed") {
  throw new Error("private test launch and vault must both be confirmed first");
}
function run(name, args) {
  return execFileSync(process.execPath, ["--use-system-ca", "node_modules/convex/bin/main.js", "run", name, JSON.stringify(args)], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
  });
}
if (process.argv.includes("--execute")) {
  console.log(run("automatedFeeEngine:registerPrivateTestLaunch", {
    tokenAddress: plan.prediction.token, vaultAddress: plan.automatedFees.predictedVault,
    deploymentSalt: plan.automatedFees.vaultSalt,
    launchTransactionHash: state.launch.transactionHash, vaultTransactionHash: state.vault.transactionHash,
  }));
}
const status = JSON.parse(run("automatedFeeEngine:privateTestStatus", { tokenAddress: plan.prediction.token }));
console.log(JSON.stringify(status, null, 2));
if (process.argv.includes("--process")) {
  if (status.program.status !== "enrolled") throw new Error("private test must be verified and enrolled first");
  const unfinished = status.runs.filter((entry) => !["confirmed", "reverted", "manual_review"].includes(entry.status));
  if (unfinished.length > 1) throw new Error("multiple pending private test runs need review");
  console.log(run("automatedFeeEngine:processProgram", {
    programId: status.program._id, ...(unfinished[0] ? { runId: unfinished[0].id } : {}),
  }));
}
if (process.argv.includes("--resume-sweep")) {
  const pending = status.runs.filter((row) => row.status === "manual_review");
  if (pending.length !== 1) throw new Error("expected exactly one stopped private test run");
  console.log(run("automatedFeeEngine:resumePrivateTestSweep", { runId: pending[0].id }));
}
