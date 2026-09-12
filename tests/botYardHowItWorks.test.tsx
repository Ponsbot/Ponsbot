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
  it("explains creation, cadence, ownership and simulated versus real funds", () => {
    const html = renderToStaticMarkup(<BotYardHowItWorks />);
    for (const text of ["three bots", "15 minutes", "45 minutes", "20%", "Paper bots", "dedicated wallet", "My Bot", "Robinhood ETH"]) expect(html).toContain(text);
    expect(html).toContain("without spending real wallet funds");
  });
  it("describes real funds for live bots", () => {
    const html = renderToStaticMarkup(<BotYardHowItWorks live />);
    expect(html).toContain("Live bots trade using funds in their dedicated wallets");
    expect(html).not.toContain("Automated trading currently runs in paper mode");
  });
});
