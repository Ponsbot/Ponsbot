import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectiveXIntakeFilters, intakeSourceTransition, restrictedXIntakeEnabled, restrictedXSearchQuery, verifiedXReadsOnly, excludedXReadCountries } from "../lib/x-intake-filter";
beforeEach(() => vi.stubEnv("X_READ_EXCLUDE_SHOW_MY_WALLET", "false"));
afterEach(() => vi.unstubAllEnvs());
it("ignores the retired country exclusion setting", () => {
  vi.stubEnv("X_READ_EXCLUDED_COUNTRIES", "in, BD,IN");
  vi.stubEnv("X_READ_VERIFIED_ONLY", "false"); vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "false");
  expect(excludedXReadCountries()).toEqual([]);
  expect(restrictedXIntakeEnabled()).toBe(false);
  expect(restrictedXSearchQuery(false, false, excludedXReadCountries())).not.toContain("place_country");
});
it("only enables on explicit true", () => {
  vi.stubEnv("X_READ_VERIFIED_ONLY", "false");
  vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "false"); expect(restrictedXIntakeEnabled()).toBe(false);
  vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "true"); expect(restrictedXIntakeEnabled()).toBe(true);
});
it("supports independent and combined verified-only filtering", () => {
  vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "false");
  vi.stubEnv("X_READ_VERIFIED_ONLY", "true");
  expect(verifiedXReadsOnly()).toBe(true);
  expect(restrictedXIntakeEnabled()).toBe(true);
  expect(restrictedXSearchQuery(false, true)).toBe("(@ponsbotfamily OR to:ponsbotfamily) is:verified -is:retweet -from:ponsbotfamily");
  expect(restrictedXSearchQuery(true, true)).toContain("-wallet -balance is:verified");
  expect(intakeSourceTransition("filtered_wallet_balance", true, Date.now(), true)?.intakeSource).toBe("filtered_wallet_balance_verified");
  expect(intakeSourceTransition("filtered_wallet_balance_verified", true, Date.now(), false)?.intakeSource).toBe("filtered_wallet_balance");
});
it("excludes wallet and balance at API level while preserving direct reply discovery", () => {
  expect(restrictedXSearchQuery()).toBe("(@ponsbotfamily OR to:ponsbotfamily) -wallet -balance -is:retweet -from:ponsbotfamily");
});
it("clears endpoint pagination and starts fresh on both enable and disable", () => {
  const now = Date.now();
  for (const patch of [intakeSourceTransition(undefined, true, now), intakeSourceTransition("filtered_wallet_balance", false, now)]) {
    expect(patch?.backlogPaginationToken).toBeUndefined();
    expect(patch?.backlogNewestPostId).toBeUndefined();
    expect(Number((BigInt(patch!.newestSeenPostId) >> 22n) + 1288834974657n)).toBe(now);
  }
});
it("does not reset an unchanged source or legacy mentions cursor", () => {
  expect(intakeSourceTransition(undefined, false, Date.now())).toBeUndefined();
  expect(intakeSourceTransition("filtered_wallet_balance", true, Date.now())).toBeUndefined();
});
it("supports a standalone exact phrase filter without excluding other wallet or balance text", () => {
  vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "false"); vi.stubEnv("X_READ_VERIFIED_ONLY", "false");
  vi.stubEnv("X_READ_EXCLUDED_COUNTRIES", ""); vi.stubEnv("X_READ_EXCLUDE_SHOW_MY_WALLET", "true");
  const f = effectiveXIntakeFilters();
  expect(f.restricted).toBe(true); expect(restrictedXIntakeEnabled()).toBe(true);
  expect(restrictedXSearchQuery(f.excludeWalletBalance, f.verifiedOnly, f.countries, f.excludeShowMyWallet))
    .toBe('(@ponsbotfamily OR to:ponsbotfamily) -"show my wallet" -is:retweet -from:ponsbotfamily');
  expect(effectiveXIntakeFilters({ excludeWalletBalance: false, verifiedOnly: false }).excludeShowMyWallet).toBe(true);
});
it("resets endpoint pagination when the phrase filter changes, including alongside broader restrictions", () => {
  const changed = intakeSourceTransition("filtered_wallet_balance_verified", true, Date.now(), true, [], true)!;
  expect(changed.intakeSource).toBe("filtered_wallet_balance_verified_no_show_my_wallet");
  expect(changed.backlogPaginationToken).toBeUndefined();
  expect(intakeSourceTransition(changed.intakeSource, true, Date.now(), true, [], true)).toBeUndefined();
  expect(intakeSourceTransition(changed.intakeSource, true, Date.now(), true, [], false)).toBeDefined();
  expect(intakeSourceTransition(undefined, false, Date.now(), false, [], true)?.intakeSource).toBe("filtered_no_show_my_wallet");
  expect(restrictedXSearchQuery(true, true, [], true).length).toBeLessThanOrEqual(512);
});
