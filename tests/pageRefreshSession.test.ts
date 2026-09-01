import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Minimal hook lifecycle driver; all timer/listener logic is the actual hook.
const hooks = vi.hoisted(() => ({ cursor: 0, states: [] as any[], effects: [] as any[], pending: [] as Array<() => void> }));
vi.mock("react", () => ({
  useState(initial: any) {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (value: any) => { hooks.states[index] = typeof value === "function" ? value(hooks.states[index]) : value; }];
  },
  useCallback: (fn: any) => fn,
  useEffect(fn: any, deps: any[]) {
    const index = hooks.cursor++, old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) hooks.pending.push(() => {
      old?.cleanup?.(); hooks.effects[index] = { deps, cleanup: fn() };
    });
  },
}));
import { usePageRefreshSession } from "../components/usePageRefreshSession";

let doc: EventTarget & { visibilityState: string };
function render() { hooks.cursor = 0; const result = usePageRefreshSession(); hooks.pending.splice(0).forEach(fn => fn()); return result; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  hooks.cursor = 0; hooks.states = []; hooks.effects = []; hooks.pending = [];
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", doc); vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { hooks.effects.forEach(e => e?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual page refresh hook lifecycle", () => {
  it("expires after five minutes and prevents a late response being applied", () => {
    const original = render(); expect(original.canRefresh()).toBe(true);
    vi.advanceTimersByTime(300_000);
    // Even a callback captured before React renders the timeout sees expiry.
    expect(original.canRefresh()).toBe(false);
    expect(render()).toMatchObject({ active: false, expired: true });
  });
  it("does not restart the deadline on a render or activity-tab change", () => {
    render(); vi.advanceTimersByTime(299_000); render(); render();
    vi.advanceTimersByTime(1000); expect(render().expired).toBe(true);
  });
  it("pauses hidden tabs and resumes them only within the original deadline", () => {
    render(); doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    expect(render().active).toBe(false);
    vi.advanceTimersByTime(100_000); doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    expect(render().active).toBe(true);
    vi.advanceTimersByTime(200_000); doc.dispatchEvent(new Event("visibilitychange"));
    expect(render().active).toBe(false);
  });
  it("only starts a fresh session after the page is remounted", () => {
    render(); vi.advanceTimersByTime(300_000); const stopped = render();
    expect(stopped.canRefresh()).toBe(false); expect(stopped).not.toHaveProperty("resume");
    hooks.effects.forEach(e => e?.cleanup?.());
    hooks.states = []; hooks.effects = []; hooks.pending = [];
    const resumed = render();
    expect(resumed.canRefresh()).toBe(true); expect(resumed.expired).toBe(false);
    vi.advanceTimersByTime(300_000); expect(render().expired).toBe(true);
  });
  it("cleans its timer on unmount", () => {
    render(); expect(vi.getTimerCount()).toBe(1);
    hooks.effects.forEach(e => e?.cleanup?.()); expect(vi.getTimerCount()).toBe(0);
  });
});
