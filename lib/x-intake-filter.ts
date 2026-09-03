export function restrictedXIntakeEnabled() {
  return walletBalanceReadsExcluded() || showMyWalletReadsExcluded() || verifiedXReadsOnly() || excludedXReadCountries().length > 0;
}

export function excludedXReadCountries() {
  // Country-level intake restrictions are currently disabled. Keep this
  // code-owned so stale deployment environment values cannot restore them.
  return [];
}

export function walletBalanceReadsExcluded() {
  return process.env.X_READ_EXCLUDE_WALLET_BALANCE === "true";
}

export function verifiedXReadsOnly() {
  // Verified-only intake has been retired. Keep the legacy environment name
  // inert so an old deployment value cannot silently restore this filter.
  return false;
}

export function showMyWalletReadsExcluded() {
  return process.env.X_READ_EXCLUDE_SHOW_MY_WALLET === "true";
}

// Automatic protection only adds restrictions; expiry cannot disable manual
// restrictions (including independently configured country exclusions).
export function effectiveXIntakeFilters(automatic: { excludeWalletBalance: boolean; verifiedOnly: boolean } = { excludeWalletBalance: false, verifiedOnly: false }) {
  const excludeWalletBalance = walletBalanceReadsExcluded() || automatic.excludeWalletBalance;
  // Automatic traffic protection may still own historical verified-filter
  // state, but it is deliberately ignored. All authors now enter through the
  // same deterministic admission and reply-queue safeguards.
  const verifiedOnly = false;
  const countries = excludedXReadCountries();
  const excludeShowMyWallet = showMyWalletReadsExcluded();
  return { excludeWalletBalance, verifiedOnly, countries, excludeShowMyWallet,
    restricted: excludeWalletBalance || excludeShowMyWallet || verifiedOnly || countries.length > 0 };
}

export function restrictedXSearchQuery(excludeWalletBalance = true, verifiedOnly = false, countries: string[] = [], excludeShowMyWallet = false) {
  void verifiedOnly;
  return "(@ponsbotfamily OR to:ponsbotfamily)" +
    (excludeWalletBalance ? " -wallet -balance" : "") +
    // X exact-phrase search is case-insensitive. This manual filter is not
    // owned by the automatic guard and survives its three-hour expiry.
    (excludeShowMyWallet ? ' -"show my wallet"' : "") +
    " -is:retweet -from:ponsbotfamily" +
    countries.map(country => ` -place_country:${country}`).join("");
}

// Changing sources must not reuse endpoint-specific page tokens, nor backfill
// posts intentionally excluded during the temporary restriction.
export function intakeSourceTransition(previous: string | undefined, restricted: boolean, now: number, verifiedOnly = false, countries: string[] = [], excludeShowMyWallet = false) {
  void verifiedOnly;
  const source = (restricted ? "filtered_wallet_balance" : countries.length || excludeShowMyWallet ? "filtered" : "mentions") + (countries.length ? `_countries_${countries.join("_")}` : "") + (excludeShowMyWallet ? "_no_show_my_wallet" : "");
  if ((previous ?? "mentions") === source) return undefined;
  return {
    intakeSource: source,
    newestSeenPostId: (((BigInt(now) - 1288834974657n) << 22n) + 4194303n).toString(),
    backlogPaginationToken: undefined,
    backlogNewestPostId: undefined,
    backlogVisitedPaginationTokens: undefined,
    backlogPaginationFailures: 0,
    updatedAt: now,
  };
}
