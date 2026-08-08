import { loadEnvConfig } from "@next/env";
import { describe, expect, it, vi } from "vitest";
import { parseXWalletIntent } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

type Operation = "create_wallet" | "show_wallet" | "show_balance" | "buy" | "sell" | "send" | "launch";
type Example = { post: string; operation?: Operation; kind?: "unknown_wallet"; fields?: Record<string, unknown> };

const commands = (operation: Operation, posts: string[]): Example[] => posts.map((post) => ({ post, operation }));

const examples: Example[] = [
  ...commands("show_wallet", [
    "@Ponsbotfamily what's my wallet?", "yo @Ponsbotfamily give me my wallet address", "@Ponsbotfamily where do I send funds to?",
    "Can you show me my Robinhood Chain wallet @Ponsbotfamily", "@Ponsbotfamily wallet", "what's my address @Ponsbotfamily",
    "Need my receiving address @Ponsbotfamily", "@Ponsbotfamily I forgot my wallet, send it again", "wallet addr? @Ponsbotfamily",
    "@Ponsbotfamily ¿cuál es mi wallet?",
  ]),
  ...commands("show_balance", [
    "@Ponsbotfamily show my holdings", "How much do I have in my wallet? @Ponsbotfamily", "@Ponsbotfamily what tokens am I holding rn",
    "portfolio check @Ponsbotfamily", "@Ponsbotfamily balance pls", "What's in the wallet? @Ponsbotfamily",
    "@Ponsbotfamily show me my ETH balance", "how much SNDK do I own @Ponsbotfamily", "@Ponsbotfamily do I have any MSFT?",
    "@Ponsbotfamily combien j'ai dans mon wallet?",
  ]),
  ...commands("buy", [
    "@Ponsbotfamily buy $25 of SNDK", "Buy me 50 bucks of SNDK @Ponsbotfamily", "@Ponsbotfamily grab $10 SNDK",
    "@Ponsbotfamily purchase 0.02 ETH worth of SNDK", "put $100 into SNDK @Ponsbotfamily", "@Ponsbotfamily gimme $5 of SNDK",
    "ape $20 into SNDK @Ponsbotfamily", "@Ponsbotfamily swap $35 for SNDK", "Can you buy SNDK with $15? @Ponsbotfamily",
    "@Ponsbotfamily buy 0.1 ETH of SNDK", "market buy $75 SNDK @Ponsbotfamily", "@Ponsbotfamily I want twenty dollars worth of SNDK",
    "send it: $200 into SNDK @Ponsbotfamily", "@Ponsbotfamily BUY $8 SNDK", "buy $12.50 of SNDK please @Ponsbotfamily",
    "@Ponsbotfamily compra $30 de SNDK", "@Ponsbotfamily achète pour $20 de SNDK", "hey bot can u buy me $40 sndk @Ponsbotfamily",
    "@Ponsbotfamily buy twenty five bucks worth of SNDK", "@Ponsbotfamily swap .05 ETH into SNDK",
  ]),
  ...commands("sell", [
    "@Ponsbotfamily sell 10 SNDK", "Sell half my SNDK @Ponsbotfamily", "@Ponsbotfamily sell 50% of my SNDK",
    "dump all my SNDK @Ponsbotfamily", "@Ponsbotfamily sell everything I have in SNDK", "cash out 25 SNDK @Ponsbotfamily",
    "@Ponsbotfamily sell a quarter of my SNDK", "@Ponsbotfamily sell 25% SNDK", "Sell my entire SNDK bag @Ponsbotfamily",
    "@Ponsbotfamily get rid of 5.5 SNDK", "@Ponsbotfamily unload half of my SNDK", "sell 100% of SNDK @Ponsbotfamily",
    "@Ponsbotfamily sell all SNDK", "can u sell 2 sndk for me @Ponsbotfamily", "@Ponsbotfamily SELL 0.25 SNDK",
  ]),
  ...commands("send", [
    "@Ponsbotfamily send 10 SNDK to @friend", "Send @alice 5 SNDK @Ponsbotfamily", "@Ponsbotfamily transfer 0.01 ETH to @bob",
    "give @charlie 2 SNDK @Ponsbotfamily", "@Ponsbotfamily send $10 of SNDK to @dave", "@Ponsbotfamily pay @erin 15 SNDK",
    "send half my SNDK to @frank @Ponsbotfamily", "@Ponsbotfamily transfer 25% of my SNDK to @george", "send all my SNDK to @henry @Ponsbotfamily",
    "@Ponsbotfamily send @ivy 0.005 ETH", "yo send 3 sndk over to @jack @Ponsbotfamily", "@Ponsbotfamily can you give @kate ten SNDK",
    "transfer 1.25 SNDK -> @leo @Ponsbotfamily", "@Ponsbotfamily SEND 8 SNDK TO @mike", "@Ponsbotfamily envoie 5 SNDK à @nina",
    "@Ponsbotfamily send 0.01 ETH to 0x1111111111111111111111111111111111111111",
    "Transfer 5 SNDK to 0x2222222222222222222222222222222222222222 @Ponsbotfamily",
    "@Ponsbotfamily send all my SNDK to 0x3333333333333333333333333333333333333333",
    "@Ponsbotfamily send half my SNDK to 0x4444444444444444444444444444444444444444",
    "send 25% SNDK to 0x5555555555555555555555555555555555555555 @Ponsbotfamily",
  ]),
  ...commands("launch", [
    "@Ponsbotfamily launch Daybreak ticker $DAY", "Launch Potato ticker $TATO @Ponsbotfamily",
    "@Ponsbotfamily create a token called Moon Rock ticker $ROCK", "@Ponsbotfamily launch Night Shift $NIGHT",
    "make me a token named Terminal Potato ticker $SPUD @Ponsbotfamily", "@Ponsbotfamily deploy Brightside ticker BRIGHT",
    "Launch \"Nothing Happens\" ticker $NOTHING @Ponsbotfamily", "@Ponsbotfamily I wanna launch My First Coin $MFC",
    "new token: Coffee Break, ticker $COFFEE @Ponsbotfamily", "@Ponsbotfamily launch The Internet Is Fine ticker $FINE",
    "@Ponsbotfamily launch Daybreak ticker $DAY, website daybreak.xyz, pair with MSFT",
    "Launch Potato Club $SPUD, description \"grown onchain\", website potatoclub.xyz @Ponsbotfamily",
    "@Ponsbotfamily create Night Shift ticker $NIGHT, pair with ETH, dev buy $100",
    "@Ponsbotfamily launch Robot Money $BOT with website robot.money and X @robotmoney",
    "Launch Terminal $TERM, description \"a token for terminal dwellers\", pair it with MSFT @Ponsbotfamily",
    "@Ponsbotfamily launch Blue Sky ticker $BLUE website bluesky.example X @blueskytoken pair ETH",
    "@Ponsbotfamily launch Good Morning ticker $GM — description: gm forever — website gm.example",
    "Launch Pons Fan Club ticker $PFC, X @ponsfanclub, website ponsfan.example @Ponsbotfamily",
    "@Ponsbotfamily launch TEST TOKEN ticker $TEST pair MSFT dev buy $25",
  ]),
  { post: "Create Potato Protocol $POTATO, pair with ETH, developer buy 0.1 ETH @Ponsbotfamily", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily buy SNDK", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily send 10 SNDK", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily launch Daybreak", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily sell 0% of my SNDK", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily what's my wallet and buy $10 SNDK then send half of it to @friend and launch Potato ticker $SPUD", kind: "unknown_wallet" },
  { post: "@Ponsbotfamily launch Daybreak ticker $DAY, website daybreak.xyz, pair with MSFT", operation: "launch", fields: { pairToken: "MSFT" } },
  { post: "@Ponsbotfamily create Night Shift ticker $NIGHT, pair with ETH, dev buy $100", operation: "launch", fields: { pairToken: "ETH", devBuy: { amount: "100", unit: "usd" } } },
];

describe.runIf(process.env.LIVE_AI_TESTS === "true")("user-provided X examples", () => {
  it("recognizes and extracts the supplied examples", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failures: unknown[] = [];
    for (let offset = 0; offset < examples.length; offset += 4) {
      const batch = examples.slice(offset, offset + 4);
      const intents = await Promise.all(batch.map(({ post }) => parseXWalletIntent(post, false)));
      intents.forEach((intent, index) => {
        const expected = batch[index];
        const operation = intent.kind === "command" ? intent.command.kind : undefined;
        const pass = expected.kind ? intent.kind === expected.kind : intent.kind === "command" && operation === expected.operation
          && (!expected.fields || Object.entries(expected.fields).every(([key, value]) => JSON.stringify(intent.command[key as keyof typeof intent.command]) === JSON.stringify(value)));
        if (!pass) failures.push({ post: expected.post, expected, intent });
      });
    }
    console.log(`USER_EXAMPLE_SUMMARY=${JSON.stringify({ total: examples.length, passed: examples.length - failures.length, failed: failures.length })}`);
    if (failures.length) console.log(`USER_EXAMPLE_FAILURES=${JSON.stringify(failures)}`);
    expect(failures.length).toBe(0);
  }, 300_000);
});
