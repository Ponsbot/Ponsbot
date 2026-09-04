import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof React>(), useEffect: (effect: () => void | (() => void)) => effects.push(effect) }));
vi.mock("@/components/usePageRefreshSession", () => ({ usePageRefreshSession: () => ({ active: true, canRefresh: () => true }) }));
vi.mock("@/components/TokenMarketSnapshot", async () => ({ TokenMarketSnapshotContext: (await import("react")).createContext({}) }));
import { TokenActivity } from "../components/TokenActivity";
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach(fn => fn()); cleanups.length = 0; effects.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });
it("retries aborted initial activity without a visibility event and follows up market data", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  let activityCalls = 0, marketCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/market/snapshot") { marketCalls++; return { ok: true, json: async () => ({ market: [] }) }; }
    activityCalls++;
    if (activityCalls === 1) throw new DOMException("Request aborted", "AbortError");
    return { ok: true, json: async () => ({ available: true, observedAt: Date.now(), trades: [] }) };
  }));
  renderToStaticMarkup(<TokenActivity tokenAddress={`0x${"1".repeat(40)}`} symbol="TEST" artwork={null} summary={null} details={null} />);
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  await vi.advanceTimersByTimeAsync(0);
  expect(activityCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(activityCalls).toBe(2);
  expect(marketCalls).toBe(2);
});
