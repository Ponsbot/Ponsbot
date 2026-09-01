export function assertPrivateFeeTestMode(environment, productionTest, processingEnabled) {
  const on = (key) => environment[key]?.trim().toLowerCase() === "true";
  if (productionTest) {
    if (!on("AUTOMATED_BUYBACK_BURN_ENABLED") || !on("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED")
      || on("AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED") || on("AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED")
      || on("AUTOMATED_FEE_BOT_COMMANDS_ENABLED") || on("AUTOMATED_FEE_MANUAL_TEST_ENABLED")) {
      throw new Error("private production test requires processing on and public capabilities/manual mode off");
    }
  } else if (on("AUTOMATED_BUYBACK_BURN_ENABLED")) {
    throw new Error("automatic processing must remain disabled during manual testing");
  }
  if (processingEnabled !== undefined && processingEnabled !== productionTest) {
    throw new Error("on-chain processing state does not match the selected test mode");
  }
}
