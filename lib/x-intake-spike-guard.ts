export const X_INTAKE_SPIKE_THRESHOLD = 60;
export const X_INTAKE_SPIKE_WINDOW_MS = 10 * 60_000;
export const X_INTAKE_SPIKE_HOLD_MS = 3 * 60 * 60_000;

export type XIntakeAutomaticFilters = { excludeWalletBalance: boolean; verifiedOnly: boolean };
export type XIntakeFilterGuardState = {
  recentPosts: { id: string; at: number }[];
  // Presence records ownership: only the guard's own overlay has an expiry.
  ownedUntil?: number;
  activatedAt?: number;
  lastReleasedAt?: number;
  triggerCount?: number;
};

export type XIntakeSpikeState = {
  excludeWalletBalance?: XIntakeFilterGuardState;
  verifiedOnly?: XIntakeFilterGuardState;
  // Legacy shared state is accepted for migration, but no longer written.
  recentPosts: { id: string; at: number }[];
  activationCount: number;
  activeUntil?: number;
  activatedAt?: number;
  lastReleasedAt?: number;
  triggerCount?: number;
};

export function xAutoIntakeGuardEnabled() {
  return process.env.X_AUTO_INTAKE_GUARD_ENABLED === "true";
}

// X snowflakes carry the post's creation time. Counting recent unique posts,
// not repeated pages or authors, avoids triggering on historical backlog.
function postTime(id: string) {
  if (!/^\d{1,25}$/.test(id)) return undefined;
  const at = Number((BigInt(id) >> 22n) + 1288834974657n);
  return Number.isSafeInteger(at) ? at : undefined;
}

function advanceFilter(
  previous: XIntakeFilterGuardState | undefined,
  now: number,
  postIds: string[],
  enabled: boolean,
  manual: boolean,
): { state: XIntakeFilterGuardState | undefined; active: boolean; activated?: boolean } {
  // A manual enable takes ownership immediately. Turning off automation only
  // drops its overlay; neither path changes the actual environment settings.
  if (!enabled || manual) return { active: false, state: previous ? {
    ...previous, recentPosts: [], ownedUntil: undefined,
    lastReleasedAt: previous.ownedUntil || previous.recentPosts.length ? now : previous.lastReleasedAt,
  } : undefined };
  let state: XIntakeFilterGuardState = previous ?? { recentPosts: [] };
  if (state.ownedUntil && state.ownedUntil > now) return { state, active: true };
  if (state.ownedUntil) state = {
    ...state, recentPosts: [], lastReleasedAt: state.ownedUntil, ownedUntil: undefined,
  };
  const cutoff = Math.max(now - X_INTAKE_SPIKE_WINDOW_MS, state.lastReleasedAt ?? 0);
  const recent = new Map(state.recentPosts.filter(p => p.at > cutoff && p.at <= now).map(p => [p.id, p]));
  for (const id of postIds) {
    const at = postTime(id);
    if (at !== undefined && at > cutoff && at <= now) recent.set(id, { id, at });
  }
  if (recent.size >= X_INTAKE_SPIKE_THRESHOLD) return { active: true, activated: true, state: {
    ...state, recentPosts: [],
    activatedAt: now, ownedUntil: now + X_INTAKE_SPIKE_HOLD_MS, triggerCount: recent.size,
  } };
  return { active: false, state: { ...state, recentPosts: [...recent.values()].sort((a, b) => a.at - b.at) } };
}

export function advanceXIntakeSpikeGuard(
  previous: XIntakeSpikeState | undefined,
  now: number,
  postIds: string[],
  enabled: boolean,
  manual: XIntakeAutomaticFilters,
): { state: XIntakeSpikeState | undefined; active: boolean; filters: XIntakeAutomaticFilters } {
  // Migrate the old shared overlay once. Manual filters never inherit ownership
  // from that overlay, and existing deadlines are not restarted on deployment.
  const legacy = previous ? {
    recentPosts: previous.recentPosts,
    ownedUntil: previous.activeUntil,
    activatedAt: previous.activatedAt,
    lastReleasedAt: previous.lastReleasedAt,
    triggerCount: previous.triggerCount,
  } : undefined;
  const wallet = advanceFilter(previous?.excludeWalletBalance ?? legacy, now, postIds, enabled, manual.excludeWalletBalance);
  const verified = advanceFilter(previous?.verifiedOnly ?? legacy, now, postIds, enabled, manual.verifiedOnly);
  const state = previous || wallet.state || verified.state ? {
    recentPosts: [],
    activationCount: (previous?.activationCount ?? 0) + (wallet.activated || verified.activated ? 1 : 0),
    excludeWalletBalance: wallet.state,
    verifiedOnly: verified.state,
  } : undefined;
  return { state, active: wallet.active || verified.active,
    filters: { excludeWalletBalance: wallet.active, verifiedOnly: verified.active } };
}
