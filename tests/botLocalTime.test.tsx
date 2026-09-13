import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hydrated: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: () => state.hydrated }));
import { BotLocalTime } from "../components/BotLocalTime";
vi.stubGlobal("React", React);
afterEach(() => { state.hydrated = false; });
const at = Date.parse("2026-09-13T01:25:00Z");
it("keeps a stable hydration placeholder instead of showing server-local time", () => {
  const html = renderToStaticMarkup(<BotLocalTime at={at} />);
  expect(html).toContain('dateTime="2026-09-13T01:25:00.000Z"');
  expect(html).toContain(">…</time>");
});
it("uses the viewer's default locale and timezone for thoughts and full dates", () => {
  state.hydrated = true;
  for (const includeDate of [false, true]) {
    const expected = new Intl.DateTimeFormat(undefined, includeDate ? { dateStyle: "medium", timeStyle: "short" } : { hour: "2-digit", minute: "2-digit" }).format(at);
    const html = renderToStaticMarkup(<BotLocalTime at={at} includeDate={includeDate} />);
    expect(html).toContain(`>${expected}</time>`);
    expect(html).not.toContain(" UTC");
  }
});
