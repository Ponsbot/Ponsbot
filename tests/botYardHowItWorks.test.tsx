import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotYardHowItWorks } from "../components/BotYardHowItWorks";

describe("Bot Yard how it works", () => {
  it("uses a collapsed native disclosure with a keyboard-accessible summary", () => {
    const html = renderToStaticMarkup(<BotYardHowItWorks />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary>How It Works</summary>");
    expect(html).not.toMatch(/<details[^>]*\sopen[\s=>]/);
  });
  it("explains creation and ownership without internal trading mechanics", () => {
    const html = renderToStaticMarkup(<BotYardHowItWorks />);
    for (const text of ["three bots", "dedicated wallet", "My Bot", "Robinhood ETH"]) expect(html).toContain(text);
    for (const text of ["15 minutes", "45 minutes", "20%", "Paper bots", "trading mode"]) expect(html).not.toContain(text);
  });
  it("describes the experience in general terms", () => {
    const html = renderToStaticMarkup(<BotYardHowItWorks />);
    expect(html).toContain("follow its trading journey");
    expect(html).not.toContain("simulate trades");
  });
});
