import { loadEnvConfig } from "@next/env";
import { describe, expect, it, vi } from "vitest";
import { parseXWalletIntent, type WalletHelpTopic } from "../convex/xWalletIntent";

loadEnvConfig(process.cwd());

type Row = { post: string; topic: WalletHelpTopic; commandAlsoOkay?: true };
const questions = (topic: WalletHelpTopic, posts: string[], commandAlsoOkay = false): Row[] =>
  posts.map((post) => ({ post, topic, ...(commandAlsoOkay ? { commandAlsoOkay: true as const } : {}) }));

const rows: Row[] = [
  ...questions("capabilities", [
    "Okay I've seen people using this all day but I'm lost 😂 @Ponsbotfamily how does this actually work?",
    "Can someone explain this to me like I'm five? @Ponsbotfamily what do you do?",
    "First time trying this. How am I supposed to use you @Ponsbotfamily?",
    "Wait so I can really manage a wallet from X? @Ponsbotfamily how does that work",
    "I'm new here 👋 @Ponsbotfamily what can I do with this bot?",
    "Seeing @Ponsbotfamily everywhere lately. What's the point of this thing?",
    "No command here, genuinely asking: @Ponsbotfamily how does Ponsbot work?",
    "Someone told me I can trade straight from X with this. How? @Ponsbotfamily",
    "So what's the workflow here? Post something and you reply? @Ponsbotfamily",
    "Could you explain how to get started @Ponsbotfamily?",
  ]),
  ...questions("wallet", [
    "Before I make one, how does the wallet part work @Ponsbotfamily?",
    "Does @Ponsbotfamily automatically make me a wallet or do I need to set one up somewhere?",
    "How do I claim a wallet with this thing @Ponsbotfamily?",
    "If I ask for my wallet, what happens exactly @Ponsbotfamily?",
    "Do I get a different wallet every time I post or is it always the same one @Ponsbotfamily?",
    "Trying to understand this before using it — is the wallet connected to my X account @Ponsbotfamily?",
    "Can I come back later and ask for the same wallet again @Ponsbotfamily?",
    "What does claim your wallet actually mean here @Ponsbotfamily?",
    "If I change my X username do I still have the same wallet @Ponsbotfamily?",
    "What chain is the wallet on again @Ponsbotfamily?",
    "Does asking what's my wallet create one if I don't already have one @Ponsbotfamily?",
  ]),
  ...questions("fund", ["How would somebody send assets into my Ponsbot wallet @Ponsbotfamily?"]),
  ...questions("balance", [
    "How do I check what tokens I'm holding @Ponsbotfamily?",
    "Can you show balances or only give me the wallet address @Ponsbotfamily?",
    "What's the right way to ask you for my holdings @Ponsbotfamily?",
    "Can I ask for just my ETH balance instead of everything @Ponsbotfamily?",
    "Would how much SNDK do I own work @Ponsbotfamily?",
    "Does it matter if I write SNDK or $SNDK when checking a balance @Ponsbotfamily?",
    "Can you look up my balance using a token CA instead of its ticker @Ponsbotfamily?",
    "If I post a contract like 0xD001000000000000000000000000000000000338 can you tell me whether I hold it @Ponsbotfamily?",
    "Is there a way to see everything in my wallet at once @Ponsbotfamily?",
    "What's the difference between asking for my wallet and asking for my holdings @Ponsbotfamily?",
  ]),
  ...questions("buy_sell", [
    "How do buys work through @Ponsbotfamily? Do I just say what I want?",
    "Do I need exact syntax to buy something or can I talk normally @Ponsbotfamily?",
    "Can I specify a buy in dollars instead of ETH @Ponsbotfamily?",
    "What if I want to buy using 0.05 ETH instead of saying a USD amount @Ponsbotfamily?",
    "Can I buy by contract address if I don't know the ticker @Ponsbotfamily?",
    "Does natural language work for trades or are there hidden commands I need to learn @Ponsbotfamily?",
    "What information do you need from me to make a buy @Ponsbotfamily?",
    "If I forget the amount when asking to buy something, will you ask me for it @Ponsbotfamily?",
    "Before I ape into anything 😂 what formats do you understand for buy amounts @Ponsbotfamily?",
    "How do sells work on here @Ponsbotfamily?",
    "Can I tell you to sell a percentage instead of an exact token amount @Ponsbotfamily?",
    "Does 50% mean the same thing as saying half @Ponsbotfamily?",
    "Can you sell a token by its CA if I don't remember its ticker @Ponsbotfamily?",
    "What happens if I ask to sell more tokens than I actually have @Ponsbotfamily?",
    "If I just say sell SNDK without an amount, what would you need from me @Ponsbotfamily?",
    "How specific do I need to be when selling something @Ponsbotfamily?",
  ]),
  ...questions("buy_sell", [
    "Would something like buy $20 of SNDK work @Ponsbotfamily?",
    "For example, could I buy a token using CA 0xD002000000000000000000000000000000000348 @Ponsbotfamily?",
    "Do I have to type buy specifically or would something like grab $20 of SNDK work @Ponsbotfamily?",
    "How would I buy $POTATO through this bot @Ponsbotfamily? Just asking how, don't buy it yet",
    "Would sell half my SNDK be understood @Ponsbotfamily?",
    "Does dump my whole $POTATO bag count as a sell request @Ponsbotfamily? 😂",
    "Would a sell using 0xD003000000000000000000000000000000000365 work @Ponsbotfamily? Not asking you to sell it",
    "Can I say cash out all my SNDK or does it have to say sell @Ponsbotfamily?",
  ], true),
  ...questions("send", [
    "How does sending tokens to another X user work @Ponsbotfamily?",
    "Can I really just send something to an @username instead of getting their wallet address @Ponsbotfamily?",
    "What info do you need if I want to send tokens to somebody @Ponsbotfamily?",
    "Can I send ETH to another X account through this @Ponsbotfamily?",
    "How do you know which wallet belongs to the person I'm sending to @Ponsbotfamily?",
    "Can the destination be a normal 0x wallet address too @Ponsbotfamily?",
    "What's the syntax for sending to a wallet address @Ponsbotfamily?",
    "Can I send half of a token balance to someone instead of entering an exact amount @Ponsbotfamily?",
    "Does the ticker need a $ when I'm sending tokens @Ponsbotfamily?",
    "Can I use a token contract address to specify what asset I want to send @Ponsbotfamily?",
    "What happens if I give you the amount and token but forget the recipient @Ponsbotfamily?",
    "Can I send my whole token balance to someone by saying send all @Ponsbotfamily?",
  ]),
  ...questions("send", [
    "Would send 10 SNDK to @alice be enough @Ponsbotfamily?",
    "Could I send to 0xD004000000000000000000000000000000000379 or do transfers only work between X users @Ponsbotfamily?",
    "Would send 25% of my $SNDK to @bob work @Ponsbotfamily?",
  ], true),
  ...questions("launch", [
    "Okay the token launch part has my attention 👀 how does launching through @Ponsbotfamily work?",
    "What do I actually need to include to launch a token on Pons V2 @Ponsbotfamily?",
    "Is a name and ticker enough to start a launch @Ponsbotfamily?",
    "Does my ticker need the $ sign when launching or can I just write DAY @Ponsbotfamily?",
    "What optional stuff can I add when launching a token @Ponsbotfamily?",
    "Can I include a website when I launch something @Ponsbotfamily?",
    "How do I attach an X account to a token launch @Ponsbotfamily?",
    "Can I add a description to the token in the same post @Ponsbotfamily?",
    "How does the developer buy work when creating a token @Ponsbotfamily?",
    "Could I launch something with a name, $ticker, website, description and dev buy all in one post @Ponsbotfamily?",
    "If I forget the ticker but give you the token name and website, will you ask me for what's missing @Ponsbotfamily?",
  ]),
  ...questions("pairs", [
    "What does pair with MSFT mean when launching on Pons V2 @Ponsbotfamily?",
    "What assets can a new token be paired with @Ponsbotfamily?",
    "Can I choose ETH as the pairing asset for a launch @Ponsbotfamily?",
  ]),
  ...questions("launch", [
    "Not launching this yet, just trying to understand the format — would Launch Potato Party ticker $SPUD, website potato.xyz, pair with ETH be valid @Ponsbotfamily?",
  ], true),
];

describe.runIf(process.env.LIVE_AI_TESTS === "true")("informational X examples", () => {
  it("keeps educational questions out of transaction execution", async () => {
    expect(process.env.OPENROUTER_API_KEY).toBeTruthy();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failures: unknown[] = [];
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = rows.slice(offset, offset + 4);
      const results = await Promise.all(batch.map(({ post }) => parseXWalletIntent(post, false)));
      results.forEach((result, index) => {
        const expected = batch[index];
        // The safety boundary matters most here: closely related help topics are
        // acceptable, while silently turning an educational example into an
        // executable command is not.
        const pass = result.kind === "help"
          || Boolean(expected.commandAlsoOkay && result.kind === "command");
        if (!pass) failures.push({ post: expected.post, expected: expected.topic, result });
      });
    }
    console.log(`INFO_EXAMPLE_SUMMARY=${JSON.stringify({ total: rows.length, passed: rows.length - failures.length, failed: failures.length })}`);
    if (failures.length) console.log(`INFO_EXAMPLE_FAILURES=${JSON.stringify(failures)}`);
    expect(failures.length).toBe(0);
  }, 300_000);
});
