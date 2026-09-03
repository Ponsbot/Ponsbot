export const AUTOMATED_FEE_ENGINE_INTERVAL_MS = 60 * 60_000;
export const AUTOMATED_FEE_BUYBACK_BPS = 500;
export const AUTOMATED_FEE_BPS_DENOMINATOR = 10_000;
export const AUTOMATED_FEE_ENGINE_LEASE_MS = 12 * 60_000;
export const AUTOMATED_FEE_MAX_PROGRAMS_PER_RUN = 20;
export const AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS = 60 * 60_000;

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;

export function automatedFeeProofMessage(timestamp: string, path: string, identity: string, bodyDigest: string) {
  // Next's catch-all route joins segments without the URL's leading slash.
  return `${timestamp}:${path.replace(/^\/+/, "")}:${identity.toLowerCase()}:${bodyDigest}`;
}

export function automatedFeeBroadcastPayload(prepared: { transactionHash: string; signedTransaction: string }, vaultAddress: string) {
  // Prepared transactions also include from/to/nonce; strict broadcast endpoints
  // intentionally accept only this signed envelope and its vault binding.
  return { transactionHash: prepared.transactionHash, signedTransaction: prepared.signedTransaction, vaultAddress };
}

export function automatedFeePreparedFields(prepared: { transactionHash: string; signedTransaction: string; nonce: number }) {
  return { transactionHash: prepared.transactionHash, signedTransaction: prepared.signedTransaction, transactionNonce: prepared.nonce };
}

export function automatedFeeExecutionFields(quote: {
  maxBuybackAmount: string; minPonsbotOut: string; minSweepBuybackTokensOut: string;
  deadline: number; routeTarget: string; routeData: string; signature: string;
}) {
  return { maxBuybackAmount: quote.maxBuybackAmount, minPonsbotOut: quote.minPonsbotOut,
    minSweepBuybackTokensOut: quote.minSweepBuybackTokensOut, deadline: quote.deadline,
    routeTarget: quote.routeTarget, routeData: quote.routeData, quoteSignature: quote.signature };
}

export function automatedFeeDeploymentConfirmed(program: { deploymentConfirmedAt?: number; enrollmentDiagnosticCode?: string }) {
  // Compatibility with confirmed upgrades prepared before the explicit marker.
  return Boolean(program.deploymentConfirmedAt || program.enrollmentDiagnosticCode === "UPGRADE_WAITING_FOR_ASSIGNMENT");
}

export type AutomatedFeeEngineEnvironment = {
  AUTOMATED_BUYBACK_BURN_ENABLED?: string;
  AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED?: string;
  AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED?: string;
  AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED?: string;
  AUTOMATED_FEE_BOT_COMMANDS_ENABLED?: string;
  AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?: string;
  AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS?: string;
  AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS?: string;
  AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS?: string;
  AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS?: string;
  AUTOMATED_FEE_ADMIN_ADDRESS?: string;
  AUTOMATED_FEE_KEEPER_ADDRESS?: string;
  AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS?: string;
  AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME?: string;
  AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?: string;
  AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?: string;
  AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS?: string;
  AUTOMATED_FEE_CONTROL_ADDRESS?: string;
  AUTOMATED_FEE_V3_ROUTER_ADDRESS?: string;
  AUTOMATED_FEE_V3_QUOTER_ADDRESS?: string;
  AUTOMATED_FEE_WETH_ADDRESS?: string;
  AUTOMATED_FEE_MANUAL_TEST_ENABLED?: string;
  AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES?: string;
};

export function automatedFeeEngineConfiguration(environment: AutomatedFeeEngineEnvironment) {
  const enabled = environment.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true";
  const requestedCapabilities = {
    sweepBuybackBurn: environment.AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true",
    newLaunchEnrollment: environment.AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED?.trim().toLowerCase() === "true",
    existingLaunchUpgrade: environment.AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED?.trim().toLowerCase() === "true",
    botCommands: environment.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() === "true",
  };
  const manualTestEnabled = environment.AUTOMATED_FEE_MANUAL_TEST_ENABLED?.trim().toLowerCase() === "true";
  const addresses = {
    vaultFactory: environment.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?.trim() || "",
    vaultImplementation: environment.AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS?.trim() || "",
    executionAdapter: environment.AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS?.trim() || "",
    nativeBuybackExecutor: environment.AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS?.trim() || "",
    pairedBuybackExecutor: environment.AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS?.trim() || "",
    admin: environment.AUTOMATED_FEE_ADMIN_ADDRESS?.trim() || "",
    keeper: environment.AUTOMATED_FEE_KEEPER_ADDRESS?.trim() || "",
    quoteAuthorizer: environment.AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS?.trim() || "",
    pauseGuardian: environment.AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS?.trim() || "",
    feeControl: environment.AUTOMATED_FEE_CONTROL_ADDRESS?.trim() || "",
    v3Router: environment.AUTOMATED_FEE_V3_ROUTER_ADDRESS?.trim() || "",
    v3Quoter: environment.AUTOMATED_FEE_V3_QUOTER_ADDRESS?.trim() || "",
    weth: environment.AUTOMATED_FEE_WETH_ADDRESS?.trim() || "",
  };
  const invalid = Object.entries(addresses)
    .filter(([, address]) => !ADDRESS.test(address) || ZERO_ADDRESS.test(address))
    .map(([name]) => name);
  const contractAddresses = [addresses.vaultFactory, addresses.vaultImplementation, addresses.executionAdapter, addresses.nativeBuybackExecutor, addresses.pairedBuybackExecutor, addresses.feeControl]
    .map((address) => address.toLowerCase());
  if (contractAddresses.every((address) => ADDRESS.test(address)) && new Set(contractAddresses).size !== contractAddresses.length) {
    invalid.push("contractAddressCollision");
  }
  const roleAddresses = [addresses.admin, addresses.keeper, addresses.pauseGuardian, addresses.quoteAuthorizer]
    .map((address) => address.toLowerCase());
  if (roleAddresses.every((address) => ADDRESS.test(address)) && new Set(roleAddresses).size !== roleAddresses.length) {
    invalid.push("roleAddressCollision");
  }
  const manualTokenEntries = (environment.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalidManualTestTokens = manualTokenEntries.filter((address) => !ADDRESS.test(address));
  const manualTestTokens = [...new Set(manualTokenEntries.filter((address) => ADDRESS.test(address)).map((address) => address.toLowerCase()))];
  const accountNames = {
    quoteAuthorizer: environment.AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME?.trim() || "",
    keeper: environment.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?.trim() || "",
    admin: environment.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "",
  };
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(accountNames.quoteAuthorizer)) invalid.push("quoteAuthorizerAccountName");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(accountNames.keeper)) invalid.push("keeperAccountName");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(accountNames.admin)) invalid.push("adminAccountName");
  const infrastructureReady = invalid.length === 0;
  const capabilities = Object.fromEntries(Object.entries(requestedCapabilities)
    .map(([name, requested]) => [name, enabled && infrastructureReady && requested])) as typeof requestedCapabilities;
  return {
    enabled,
    ready: enabled && infrastructureReady,
    infrastructureReady,
    requestedCapabilities,
    capabilities,
    manualTestEnabled,
    manualTestReady: manualTestEnabled && infrastructureReady && invalidManualTestTokens.length === 0 && manualTestTokens.length > 0,
    manualTestTokens,
    invalidManualTestTokens,
    addresses, accountNames,
    invalid,
  };
}

export function isAutomatedFeeManualTestToken(tokenAddress: string, allowlist: string[]) {
  return ADDRESS.test(tokenAddress) && allowlist.includes(tokenAddress.toLowerCase());
}

export function automatedFeeProcessingAllowed(config: ReturnType<typeof automatedFeeEngineConfiguration>) {
  // Continuing an enrolled program must not depend on accepting NEW enrollments.
  return config.ready && config.capabilities.sweepBuybackBurn;
}

export function automatedFeePrivateTestEnrollmentAllowed(config: ReturnType<typeof automatedFeeEngineConfiguration>) {
  return automatedFeeProcessingAllowed(config)
    && !config.requestedCapabilities.newLaunchEnrollment
    && !config.requestedCapabilities.existingLaunchUpgrade
    && !config.requestedCapabilities.botCommands
    && !config.manualTestEnabled;
}

export function automatedFeeEnrollmentAllowed(
  config: ReturnType<typeof automatedFeeEngineConfiguration>,
  tokenAddress: string,
  source: "new_launch" | "upgrade",
  productionImplementationReady: boolean,
  privateManualTestImplementationReady: boolean,
) {
  if (config.ready && productionImplementationReady) {
    return source === "new_launch" ? config.capabilities.newLaunchEnrollment : config.capabilities.existingLaunchUpgrade;
  }
  return source === "upgrade"
    && privateManualTestImplementationReady
    && config.manualTestReady
    && isAutomatedFeeManualTestToken(tokenAddress, config.manualTestTokens);
}

/** Direct Pons holder sharing bypasses the Pons Bot vault and is therefore
 * outside the automated PONSBOT buyback-and-burn flywheel. */
export function automatedFeeDistributionEligible(distributionMode: "wallet" | "holders") {
  return distributionMode === "wallet";
}

export function splitAutomatedCreatorFees(gross: bigint, buybackBps = AUTOMATED_FEE_BUYBACK_BPS) {
  if (gross < 0n) throw new Error("gross creator fees cannot be negative");
  if (!Number.isInteger(buybackBps) || buybackBps < 0 || buybackBps > AUTOMATED_FEE_BPS_DENOMINATOR) {
    throw new Error("buyback basis points are invalid");
  }
  const buyback = gross * BigInt(buybackBps) / BigInt(AUTOMATED_FEE_BPS_DENOMINATOR);
  return { gross, buyback, beneficiary: gross - buyback };
}

export function automatedFeeRunIdempotencyKey(tokenAddress: string, processThroughBlock: string) {
  const token = tokenAddress.toLowerCase();
  if (!ADDRESS.test(token) || !/^\d+$/.test(processThroughBlock)) throw new Error("automated fee run identity is invalid");
  return `automated-fees:${token}:${processThroughBlock}`;
}

export function validateAutomatedFeeReceipt(values: {
  grossClaimed: string;
  beneficiaryAllocated: string;
  buybackSpent: string;
  ponsbotBurned: string;
}) {
  const entries = Object.values(values);
  if (entries.some((value) => !/^\d+$/.test(value))) throw new Error("automated fee receipt values are invalid");
  const gross = BigInt(values.grossClaimed);
  const allocation = BigInt(values.beneficiaryAllocated);
  const buyback = BigInt(values.buybackSpent);
  const burned = BigInt(values.ponsbotBurned);
  const expected = splitAutomatedCreatorFees(gross);
  if (gross === 0n) throw new Error("automated fee receipt gross amount is zero");
  if (allocation !== expected.beneficiary || buyback !== expected.buyback) {
    throw new Error("automated fee receipt accounting invariant failed");
  }
  if (buyback > 0n && burned === 0n) throw new Error("automated fee receipt burn invariant failed");
  if (buyback === 0n && burned !== 0n) throw new Error("automated fee receipt zero-buyback burn invariant failed");
  return { gross, allocation, buyback, burned };
}
