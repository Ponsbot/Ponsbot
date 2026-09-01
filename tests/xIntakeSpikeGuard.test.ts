import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceXIntakeSpikeGuard as advance, X_INTAKE_SPIKE_HOLD_MS as HOLD, X_INTAKE_SPIKE_WINDOW_MS as WINDOW, xAutoIntakeGuardEnabled } from "../lib/x-intake-spike-guard";
import { effectiveXIntakeFilters, restrictedXSearchQuery } from "../lib/x-intake-filter";
import { observeIntakeTraffic, preparePollSource } from "../convex/xReplies";

const now = Date.UTC(2026, 7, 30, 23);
const id = (at: number, sequence = 0) => (((BigInt(at) - 1288834974657n) << 22n) + BigInt(sequence)).toString();
const posts = (n: number, at = now) => Array.from({ length: n }, (_, i) => id(at, i));
const none = { excludeWalletBalance: false, verifiedOnly: false };
const both = { excludeWalletBalance: true, verifiedOnly: true };
const handler = (fn: any) => fn._handler;

beforeEach(() => {
  vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "false");
  vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "false");
  vi.stubEnv("X_READ_VERIFIED_ONLY", "false");
  vi.stubEnv("X_READ_EXCLUDED_COUNTRIES", "");
  vi.stubEnv("X_READ_EXCLUDE_SHOW_MY_WALLET", "false");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("automatic X intake spike policy", () => {
  it("is opt-in and creates no clock or state while disabled", () => {
    expect(xAutoIntakeGuardEnabled()).toBe(false);
    expect(advance(undefined, now, posts(100), false, none)).toEqual({ active: false, state: undefined, filters: none });
    vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "TRUE");
    expect(xAutoIntakeGuardEnabled()).toBe(false);
  });
  it("triggers exactly at 60 unique recent posts", () => {
    expect(HOLD).toBe(3 * 60 * 60_000);
    const first = advance(undefined, now, posts(59), true, none);
    expect(first.active).toBe(false);
    expect(first.state?.excludeWalletBalance?.recentPosts).toHaveLength(59);
    const triggered = advance(first.state, now, [id(now, 59)], true, none);
    expect(triggered.active).toBe(true);
    expect(triggered.state?.excludeWalletBalance).toMatchObject({ activatedAt: now, ownedUntil: now + HOLD, triggerCount: 60, recentPosts: [] });
    expect(triggered.state?.verifiedOnly).toEqual(triggered.state?.excludeWalletBalance);
    expect(triggered.state?.activationCount).toBe(1);
  });
  it("counts across polls and deduplicates repeated pages", () => {
    const first = advance(undefined, now, posts(20, now - 300_000), true, none);
    const repeated = advance(first.state, now, posts(20, now - 300_000), true, none);
    expect(repeated.state?.excludeWalletBalance?.recentPosts).toHaveLength(20);
    expect(advance(repeated.state, now, posts(40), true, none).active).toBe(true);
  });
  it("ignores old backlog, invalid IDs, future posts and the open ten-minute boundary", () => {
    expect(advance(undefined, now, [...posts(40, now - WINDOW), ...posts(40, now + 1), "bogus", "-1", "9999999999999999999999999999999999999"], true, none).state?.excludeWalletBalance?.recentPosts).toHaveLength(0);
  });
  it("expires old samples without storing more than 59 while monitoring", () => {
    const first = advance(undefined, now, posts(59, now - WINDOW + 1), true, none);
    const next = advance(first.state, now + 1, [id(now + 1)], true, none);
    expect(next.active).toBe(false);
    expect(next.state?.excludeWalletBalance?.recentPosts).toHaveLength(1);
  });
  it("holds for exactly three hours without extending during more traffic", () => {
    const first = advance(undefined, now, posts(100), true, none);
    const busy = advance(first.state, now + HOLD - 1, posts(100, now + HOLD - 1), true, none);
    expect(busy.active).toBe(true);
    expect(busy.state).toEqual(first.state);
    const expired = advance(first.state, now + HOLD, [], true, none);
    expect(expired.active).toBe(false);
    expect(expired.state?.excludeWalletBalance?.ownedUntil).toBeUndefined();
    expect(expired.state?.excludeWalletBalance?.lastReleasedAt).toBe(now + HOLD);
  });
  it("resumes monitoring after expiry without counting the restricted-period backlog", () => {
    const first = advance(undefined, now, posts(60), true, none);
    const old = advance(first.state, now + HOLD + 1, posts(100, now + HOLD - 1), true, none);
    expect(old.active).toBe(false);
    expect(old.state?.excludeWalletBalance?.recentPosts).toHaveLength(0);
    const second = advance(old.state, now + HOLD + 2, posts(60, now + HOLD + 2), true, none);
    expect(second.active).toBe(true);
    expect(second.state?.activationCount).toBe(2);
  });
  it("does not start a revert timer for manually enabled protection", () => {
    const result = advance(undefined, now, posts(100), true, both);
    expect(result.active).toBe(false);
    expect(result.state).toBeUndefined();
  });
  it("turning the feature off clears only its own override and stale samples", () => {
    const first = advance(undefined, now, posts(60), true, none);
    const stopped = advance(first.state, now + 1, [], false, none);
    expect(stopped.active).toBe(false);
    expect(stopped.state?.excludeWalletBalance?.ownedUntil).toBeUndefined();
    expect(advance(stopped.state, now + 2, [], true, none).active).toBe(false);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("preserves manual wallet=%s verified=%s filters after expiry", (wallet, verified) => {
    vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", String(wallet));
    vi.stubEnv("X_READ_VERIFIED_ONLY", String(verified));
    vi.stubEnv("X_READ_EXCLUDED_COUNTRIES", "IN,BD");
    expect(effectiveXIntakeFilters(both)).toEqual({ excludeWalletBalance: true, verifiedOnly: true, countries: [], excludeShowMyWallet: false, restricted: true });
    expect(effectiveXIntakeFilters(none)).toEqual({ excludeWalletBalance: wallet, verifiedOnly: verified, countries: [], excludeShowMyWallet: false, restricted: wallet || verified });
    expect(process.env.X_READ_EXCLUDE_WALLET_BALANCE).toBe(String(wallet));
  });
});

describe("independent automatic filter ownership", () => {
  const keys = ["excludeWalletBalance", "verifiedOnly"] as const;
  it("starts no timers when enabled over existing manual filters, even hours later", () => {
    const first = advance(undefined, now, posts(100), true, both);
    expect(first).toEqual({ state: undefined, active: false, filters: none });
    expect(advance(first.state, now + 2 * HOLD, posts(100, now + 2 * HOLD), true, both)).toEqual(first);
  });
  it.each(keys)("only owns the missing filter when %s is manual", key => {
    const manual = { ...none, [key]: true };
    const other = key === "verifiedOnly" ? "excludeWalletBalance" : "verifiedOnly";
    const first = advance(undefined, now, posts(60), true, manual);
    expect(first.filters).toEqual({ ...both, [key]: false });
    expect(first.state?.[key]?.ownedUntil).toBeUndefined();
    expect(first.state?.[other]?.ownedUntil).toBe(now + HOLD);
    const expired = advance(first.state, now + HOLD, [], true, manual);
    expect(expired.filters).toEqual(none);
    vi.stubEnv(key === "verifiedOnly" ? "X_READ_VERIFIED_ONLY" : "X_READ_EXCLUDE_WALLET_BALANCE", "true");
    expect(effectiveXIntakeFilters(expired.filters)).toMatchObject(manual);
  });
  it.each(keys)("manual takeover of %s relinquishes only that overlay", key => {
    const other = key === "verifiedOnly" ? "excludeWalletBalance" : "verifiedOnly";
    const first = advance(undefined, now, posts(60), true, none);
    const manual = advance(first.state, now + 60_000, [], true, { ...none, [key]: true });
    expect(manual.state?.[key]?.ownedUntil).toBeUndefined();
    expect(manual.state?.[other]?.ownedUntil).toBe(now + HOLD);
    // Clearing the manual switch must not resurrect the old automatic lease.
    const released = advance(manual.state, now + 120_000, posts(60), true, none);
    expect(released.filters[key]).toBe(false);
    expect(released.filters[other]).toBe(true);
  });
  it.each(keys)("staggered %s activation has independent observations and a full three hours", key => {
    const other = key === "verifiedOnly" ? "excludeWalletBalance" : "verifiedOnly";
    const first = advance(undefined, now, posts(60), true, { ...none, [key]: true });
    const second = advance(first.state, now + 300_000, posts(59, now + 300_000), true, none);
    expect(second.filters[key]).toBe(false);
    const triggered = advance(second.state, now + 300_000, [id(now + 300_000, 59)], true, none);
    expect(triggered.state?.[key]?.ownedUntil).toBe(now + 300_000 + HOLD);
    expect(triggered.state?.[other]?.ownedUntil).toBe(now + HOLD);
    const expired = advance(triggered.state, now + HOLD, [], true, none);
    expect(expired.filters).toEqual({ ...none, [key]: true });
    expect(advance(expired.state, now + HOLD + 300_000, [], true, none).filters).toEqual(none);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("migrates legacy state without claiming manual wallet=%s verified=%s or restarting timers", (wallet, verified) => {
    const manual = { excludeWalletBalance: wallet, verifiedOnly: verified };
    const legacy = { recentPosts: [], activationCount: 1, activatedAt: now - 1000, activeUntil: now + HOLD - 1000 };
    const result = advance(legacy, now, [], true, manual);
    expect(result.filters).toEqual({ excludeWalletBalance: !wallet, verifiedOnly: !verified });
    expect(result.state?.activeUntil).toBeUndefined();
    for (const key of keys) expect(result.state?.[key]?.ownedUntil).toBe(manual[key] ? undefined : legacy.activeUntil);
    expect(advance(result.state, legacy.activeUntil, [], true, manual).filters).toEqual(none);
  });
  it("disabling automation preserves manual filters while clearing both auto leases", () => {
    const first = advance(undefined, now, posts(60), true, none);
    vi.stubEnv("X_READ_VERIFIED_ONLY", "true");
    vi.stubEnv("X_READ_EXCLUDED_COUNTRIES", "IN,BD");
    const stopped = advance(first.state, now + 1, [], false, { ...none, verifiedOnly: true });
    for (const key of keys) expect(stopped.state?.[key]?.ownedUntil).toBeUndefined();
    expect(effectiveXIntakeFilters(stopped.filters)).toEqual({ excludeWalletBalance: false, verifiedOnly: true, countries: [], excludeShowMyWallet: false, restricted: true });
  });
});

function fixture(initial: any = {}) {
  const row: any = { _id: "state", key: "mentions", leaseUntil: now + 15 * 60_000, updatedAt: now, ...initial };
  const query: any = { withIndex: vi.fn(() => query), unique: vi.fn(async () => row) };
  const db = { query: vi.fn(() => query), patch: vi.fn(async (_id: string, patch: any) => Object.assign(row, patch)) };
  return { row, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}

describe("durable poll integration (no X/network calls)", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
  it("enabling the guard over current manual filters never acquires timers or resets their cursor", async () => {
    vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "true");
    vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "true");
    vi.stubEnv("X_READ_VERIFIED_ONLY", "true");
    const f = fixture({ intakeSource: "filtered_wallet_balance_verified", backlogPaginationToken: "existing-page" });
    await handler(observeIntakeTraffic)(f.ctx, { postIds: posts(100) });
    for (const time of [now, now + HOLD, now + 2 * HOLD]) {
      vi.mocked(Date.now).mockReturnValue(time);
      f.row.leaseUntil = time + 60_000;
      const ready = await handler(preparePollSource)(f.ctx, {});
      expect(ready.effectiveFilters).toMatchObject(both);
      expect(f.row.intakeSpikeGuard).toBeUndefined();
      expect(f.row.backlogPaginationToken).toBe("existing-page");
    }
    expect(f.ctx.db.patch).not.toHaveBeenCalled();
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["excludeWalletBalance", "verifiedOnly"] as const)("keeps manual %s search when only the auto filter expires", async key => {
    vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "true");
    vi.stubEnv(key === "verifiedOnly" ? "X_READ_VERIFIED_ONLY" : "X_READ_EXCLUDE_WALLET_BALANCE", "true");
    const f = fixture();
    await handler(observeIntakeTraffic)(f.ctx, { postIds: posts(60) });
    await handler(preparePollSource)(f.ctx, {});
    vi.mocked(Date.now).mockReturnValue(now + HOLD);
    f.row.leaseUntil = now + HOLD + 60_000;
    const expired = await handler(preparePollSource)(f.ctx, {});
    expect(expired.effectiveFilters).toMatchObject({ ...none, [key]: true });
    expect(f.row.intakeSource).toBe(key === "verifiedOnly" ? "filtered_verified" : "filtered_wallet_balance");
  });
  it("disabled observation touches no live state and manual filters get no expiry", async () => {
    vi.stubEnv("X_READ_EXCLUDE_WALLET_BALANCE", "true");
    vi.stubEnv("X_READ_VERIFIED_ONLY", "true");
    const f = fixture({ intakeSource: "filtered_wallet_balance_verified" });
    await handler(observeIntakeTraffic)(f.ctx, { postIds: posts(100) });
    expect(f.ctx.db.query).not.toHaveBeenCalled();
    const ready = await handler(preparePollSource)(f.ctx, {});
    expect(ready.effectiveFilters.verifiedOnly).toBe(true);
    expect(f.row.intakeSpikeGuard).toBeUndefined();
    expect(f.ctx.db.patch).not.toHaveBeenCalled();
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("switches API search filters, drops endpoint pagination and restores baseline after the hold", async () => {
    vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "true");
    const f = fixture({ intakeSource: "mentions", backlogPaginationToken: "mentions-page" });
    const active = await handler(observeIntakeTraffic)(f.ctx, { postIds: posts(60) });
    expect(active).toMatchObject({ excludeWalletBalance: true, verifiedOnly: true });
    const prepared = await handler(preparePollSource)(f.ctx, {});
    expect(restrictedXSearchQuery(prepared.effectiveFilters.excludeWalletBalance, prepared.effectiveFilters.verifiedOnly))
      .toContain(" -wallet -balance is:verified");
    expect(f.row.intakeSource).toBe("filtered_wallet_balance_verified");
    expect(f.row.backlogPaginationToken).toBeUndefined();
    expect(f.row.intakeSpikeGuard.excludeWalletBalance.ownedUntil).toBe(now + HOLD);
    vi.mocked(Date.now).mockReturnValue(now + HOLD);
    f.row.leaseUntil = now + HOLD + 60_000;
    f.row.backlogPaginationToken = "search-page";
    const expired = await handler(preparePollSource)(f.ctx, {});
    expect(expired.effectiveFilters.restricted).toBe(false);
    expect(f.row.intakeSource).toBe("mentions");
    expect(f.row.backlogPaginationToken).toBeUndefined();
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("requires the poll lease and refuses an oversized observation", async () => {
    vi.stubEnv("X_AUTO_INTAKE_GUARD_ENABLED", "true");
    const f = fixture({ leaseUntil: now });
    await expect(handler(observeIntakeTraffic)(f.ctx, { postIds: posts(60) })).rejects.toThrow("Poll lease required");
    await expect(handler(observeIntakeTraffic)(f.ctx, { postIds: posts(101) })).rejects.toThrow("exceeds one page");
  });
});
