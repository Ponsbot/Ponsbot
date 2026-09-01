import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchGrid } from "../components/LaunchGrid";
import { TokenActivity } from "../components/TokenActivity";

const session = vi.hoisted(() => ({ active: false, expired: true, canRefresh: () => false }));
vi.mock("@/components/usePageRefreshSession", () => ({ usePageRefreshSession: () => session }));
vi.mock("@/components/LaunchCard", () => ({ LaunchCard: () => null }));
vi.mock("@/components/TokenMarketSnapshot", async () => {
  const { createContext } = await import("react");
  return { TokenMarketSnapshotContext: createContext({}) };
});

beforeEach(() => { vi.stubGlobal("React", React); session.active = false; session.expired = true; });
afterEach(() => vi.unstubAllGlobals());

const tokenProps = {
  tokenAddress: `0x${"1".repeat(40)}`, poolAddress: `0x${"2".repeat(40)}`, symbol: "PONSBOT",
  currentMarketCapUsd: 1234, volume24hUsd: 567, artwork: null, summary: null, details: null,
};

function expectSilentPause(html: string) {
  expect(html).not.toMatch(/resume updates|updates paused|refresh-paused/i);
}

describe("silent page refresh expiry", () => {
  it("does not show a resume button or notification on the launch feed", () => {
    const html = renderToStaticMarkup(React.createElement(LaunchGrid, { launches: [], launchCount: 0 }));
    expectSilentPause(html);
    expect(html).toContain("Highest MCap");
  });

  it.each([
    { active: true, expired: false, label: "active" },
    { active: false, expired: false, label: "hidden" },
    { active: false, expired: true, label: "expired" },
  ])("keeps the chart rendered during an $label polling session", ({ active, expired }) => {
    Object.assign(session, { active, expired });
    const html = renderToStaticMarkup(React.createElement(TokenActivity, tokenProps));
    expectSilentPause(html);
    expect(html).toContain("<iframe");
    expect(html).toContain(`https://www.geckoterminal.com/robinhood/tokens/${tokenProps.tokenAddress}`);
    expect(html).toContain("$1,234.00");
    expect(html).toContain("$567.00");
  });

  it("retains the existing no-chart message when a pool is unavailable", () => {
    const html = renderToStaticMarkup(React.createElement(TokenActivity, { ...tokenProps, poolAddress: undefined }));
    expectSilentPause(html);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Chart data is not available for this launch yet.");
  });
});
