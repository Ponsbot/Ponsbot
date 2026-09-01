const site = String(process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
const signer = String(process.env.WALLET_SIGNER_URL ?? (site ? `${site}/api/wallet-signer` : "")).trim().replace(/\/$/, "");
const token = String(process.env.WALLET_SIGNER_TOKEN ?? "").trim();
if (!/^https:\/\//i.test(signer) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(signer)) {
  throw new Error("WALLET_SIGNER_URL or NEXT_PUBLIC_SITE_URL is missing or invalid");
}
if (!token) throw new Error("WALLET_SIGNER_TOKEN is missing");

const response = await fetch(`${signer}/v1/automated-fees/infrastructure-status`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(60_000),
});
const raw = await response.text();
if (!response.ok) throw new Error(`readiness endpoint failed (${response.status}): ${raw.slice(0, 500)}`);
const status = JSON.parse(raw);
const missingRoutes = (status.routes ?? []).filter((route) => !route.matches).map((route) => route.symbol);
const missingContracts = Object.entries(status.contractCode ?? {}).filter(([, present]) => !present).map(([name]) => name);
const minimumOperationalBalanceWei = 5_000_000_000_000_000n;
const lowBalances = Object.entries(status.balancesWei ?? {})
  .filter(([role]) => role !== "quoteAuthorizer")
  .filter(([, value]) => BigInt(String(value)) < minimumOperationalBalanceWei)
  .map(([role]) => role);

const infrastructureReady = status.configurationValid === true
  && status.chainId === 4663
  && status.allRoutesReady && status.allContractsDeployed === true
  && status.controlMatches === true && status.factoryMatches === true
  && status.enrollmentProofConfigured === true && lowBalances.length === 0;
const activationRequested = status.productionRequested === true && status.processingRequested === true;
const operational = infrastructureReady && activationRequested && status.processingEnabled === true;
const readyForFinalActivation = infrastructureReady && activationRequested && status.processingEnabled === false;
const safelyDisabled = !status.productionRequested && !status.processingRequested && status.processingEnabled === false;

const result = {
  status: operational ? "operational"
    : readyForFinalActivation ? "ready_for_activation"
      : safelyDisabled ? "safely_disabled" : "configuration_mismatch",
  chainId: status.chainId,
  configurationValid: status.configurationValid === true,
  missingConfiguration: status.missingConfiguration ?? [],
  invalidConfiguration: status.invalidConfiguration ?? [],
  onChainProcessingEnabled: status.processingEnabled,
  productionRequested: status.productionRequested,
  processingRequested: status.processingRequested,
  configuredRoutes: (status.routes ?? []).length - missingRoutes.length,
  totalRoutes: (status.routes ?? []).length,
  missingRoutes,
  missingContracts,
  enrollmentProofConfigured: status.enrollmentProofConfigured === true,
  controlMatches: status.controlMatches === true,
  factoryMatches: status.factoryMatches === true,
  lowBalanceRoles: lowBalances,
  readyForFinalActivation,
  operational,
  mutationSent: false,
};
console.log(JSON.stringify(result, null, 2));
if (!operational && !readyForFinalActivation && !safelyDisabled) process.exitCode = 1;
