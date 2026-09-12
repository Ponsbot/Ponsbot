import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotYard } from "../components/BotYard";
import { botYardPreviewBots } from "../lib/trading-agents/yard-preview";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
describe("Bot Yard presentation", () => {
  it("renders an explicit preview with selectable characters and a log", () => {
    const html = renderToStaticMarkup(<BotYard bots={botYardPreviewBots()} preview />);
    expect(html).toContain("Local design preview"); expect(html).toContain("Moss, view log");
    expect(html).toContain("Created by"); expect(html).toContain('href="https://x.com/example_creator"');
    expect(html).toContain("Choose a bot without following its movement"); expect(html).toContain("No trade this time.");
  });
  it("does not invent wallet links for paper bots", () => {
    const html = renderToStaticMarkup(<BotYard bots={botYardPreviewBots()} />);
    expect(html).toContain("Bot wallet not created"); expect(html).not.toContain('href="/wallet/');
  });
  it("provides wallet and transaction-history links only for an assigned address", () => {
    const address = `0x${"1".repeat(40)}`;
    const html = renderToStaticMarkup(<BotYard bots={[{ ...botYardPreviewBots()[0], walletAddress: address }]} />);
    expect(html).toContain(`href="/bot-yard/wallet/${address}"`);
    expect(html).toContain(`href="https://robinhoodchain.blockscout.com/address/${address}?tab=txs"`);
  });
  it("escapes bot descriptions and public observations", () => {
    const bot = botYardPreviewBots()[0]; bot.description = '<img src=x onerror="alert(1)">'; bot.logs[0].summary = "<script>alert(1)</script>";
    const html = renderToStaticMarkup(<BotYard bots={[bot]} />);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img");
  });
  it("renders an empty yard without fake bots or transactions", () => {
    const html = renderToStaticMarkup(<BotYard bots={[]} />);
    expect(html).toContain("No bots have moved in yet"); expect(html).not.toContain("Paper buy");
  });
  it("does not construct a profile link from an invalid creator handle", () => {
    const html = renderToStaticMarkup(<BotYard bots={[{ ...botYardPreviewBots()[0], creatorUsername: "evil/path" }]} />);
    expect(html).toContain("Creator unavailable"); expect(html).not.toContain("https://x.com/");
  });
});
