import { describe, expect, it } from "vitest";
import {
  advanceGuidedLaunch,
  createGuidedLaunchState,
  decodeGuidedLaunchState,
  guidedLaunchPrompt,
  guidedLaunchRequested,
  type GuidedLaunchState,
} from "../lib/guided-launch-workflow";

function prompt(result: ReturnType<typeof advanceGuidedLaunch>) {
  if (result.kind !== "prompt") throw new Error(`expected prompt, received ${result.kind}`);
  return result;
}

function answer(state: GuidedLaunchState, text: string, mediaUrl?: string) {
  return prompt(advanceGuidedLaunch(state, text, mediaUrl)).state;
}

function reachOptionalFields() {
  let state = createGuidedLaunchState(true);
  state = answer(state, 'name: "Green Harbor"');
  state = answer(state, "ticker $GHRB");
  return state;
}

describe("guided X launch workflow", () => {
  it.each([
    "launch", "launch a token", "create a coin", "I want to launch a token", "I want to create a token", "help me launch",
    "start", "please start", "get started", "please get started", "lets get start", "let's get started", "let’s get this started",
    "launch on Pons", "launch on Pons V2",
  ])("starts only from a short launch selection: %s", text => {
    expect(guidedLaunchRequested(text)).toBe(true);
  });

  it.each([
    "launch Green Harbor ticker GHRB", "buy a token", "create liquidity", "how do launches work?",
    "It's getting started!", "The launch is getting started", "Please start by telling me how launches work",
    "Let's start by buying $5 of PONSBOT", "We should start a liquidity position",
  ])("does not intercept a complete command or another function: %s", text => {
    expect(guidedLaunchRequested(text)).toBe(false);
  });

  it("collects required name and ticker before optional fields", () => {
    let state = createGuidedLaunchState(true);
    expect(state.phase).toBe("name");
    state = answer(state, 'Token name: "Green Harbor"');
    expect(state).toMatchObject({ phase: "ticker", draft: { name: "Green Harbor" } });
    state = answer(state, "symbol: $ghrb");
    expect(state).toMatchObject({ phase: "artwork", draft: { symbol: "GHRB" } });
  });

  it("rejects invalid required values without advancing", () => {
    const state = createGuidedLaunchState(true);
    const badName = prompt(advanceGuidedLaunch(state, "https://example.com"));
    expect(badName.state.phase).toBe("name");
    const tickerState = answer(state, "Green Harbor");
    const badTicker = prompt(advanceGuidedLaunch(tickerState, "ticker $$$"));
    expect(badTicker.state.phase).toBe("ticker");
  });

  it("does not mistake question-like token content for a workflow question", () => {
    let state = createGuidedLaunchState(true);
    state = answer(state, "What If?");
    expect(state).toMatchObject({ phase: "ticker", draft: { name: "What If?" } });
    state = answer(state, "WHY?");
    expect(state).toMatchObject({ phase: "artwork", draft: { symbol: "WHY" } });
  });

  it("persists direct artwork and skips the artwork question when supplied early", () => {
    let state = createGuidedLaunchState(true);
    state = answer(state, "Green Harbor", "https://pbs.twimg.com/media/test.jpg");
    state = answer(state, "GHRB");
    expect(state.phase).toBe("description");
    expect(state.draft.imageUrl).toContain("pbs.twimg.com");
  });

  it("accepts no or none for every optional field", () => {
    let state = reachOptionalFields();
    for (const phase of ["artwork", "description", "website", "twitter", "telegram", "pair", "dev_buy", "fees"] as const) {
      expect(state.phase).toBe(phase);
      state = answer(state, phase === "website" ? "none" : "no");
    }
    expect(state.phase).toBe("confirm");
    expect(state.draft).toMatchObject({ name: "Green Harbor", symbol: "GHRB" });
    expect(state.draft.pairToken).toBeUndefined();
  });

  it("distinguishes skipping an optional field from cancelling the workflow", () => {
    const optional = reachOptionalFields();
    const skipped = prompt(advanceGuidedLaunch(optional, "no"));
    expect(skipped.state.phase).toBe("description");
    expect(advanceGuidedLaunch(optional, "cancel")).toMatchObject({ kind: "cancelled" });
  });

  it("normalizes optional links and safely omits malformed Telegram", () => {
    let state = reachOptionalFields();
    state = answer(state, "no");
    state = answer(state, "A community token");
    state = answer(state, "greenharbor.example");
    state = answer(state, "@greenharbor");
    const telegram = prompt(advanceGuidedLaunch(state, "@not-a-link"));
    expect(telegram.state.phase).toBe("pair");
    expect(telegram.message).toContain("omitted");
    expect(telegram.state.draft).toMatchObject({
      website: "https://greenharbor.example",
      twitter: "https://x.com/greenharbor",
    });
    expect(telegram.state.draft.telegram).toBeUndefined();
  });

  it("normalizes pairing aliases and developer buys", () => {
    let state = reachOptionalFields();
    for (let index = 0; index < 5; index += 1) state = answer(state, "no");
    state = answer(state, "Microsoft");
    expect(state).toMatchObject({ phase: "dev_buy", draft: { pairToken: "MSFT" } });
    state = answer(state, "5 MSFT");
    expect(state).toMatchObject({ phase: "fees", draft: { devBuy: { amount: "5", unit: "pair" } } });
  });

  it.each(["paired with Microsoft", "paired to MSFT", "pair it to MSFT", "as the pair MSFT", "with asset pair MSFT"])(
    "accepts a natural pair choice: %s",
    choice => {
      let state = reachOptionalFields();
      for (let index = 0; index < 5; index += 1) state = answer(state, "no");
      state = answer(state, choice);
      expect(state).toMatchObject({ phase: "dev_buy", draft: { pairToken: "MSFT" } });
    },
  );

  it("keeps unsupported pair values at the pair step", () => {
    let state = reachOptionalFields();
    for (let index = 0; index < 5; index += 1) state = answer(state, "no");
    const result = prompt(advanceGuidedLaunch(state, "FAKEPAIR"));
    expect(result.state.phase).toBe("pair");
    expect(result.message).toContain("not currently supported");
  });

  it.each([
    ["@alice", { feeRecipient: "@alice" }],
    ["assign fees to @alice", { feeRecipient: "@alice" }],
    ["holders", { holderFeeSharing: true }],
    ["share with holders", { holderFeeSharing: true }],
  ] as const)("collects the final creator-fee choice: %s", (choice, expected) => {
    let state = reachOptionalFields();
    for (let index = 0; index < 7; index += 1) state = answer(state, "no");
    state = answer(state, choice);
    expect(state.phase).toBe("confirm");
    expect(state.draft).toMatchObject(expected);
  });

  it("answers a step question without losing the draft or advancing", () => {
    const state = reachOptionalFields();
    const result = prompt(advanceGuidedLaunch(state, "What does artwork mean?"));
    expect(result.state).toEqual(state);
    expect(result.message).toContain(guidedLaunchPrompt("artwork"));
  });

  it("requires confirmation and emits one validated launch command", () => {
    let state = reachOptionalFields();
    state = answer(state, "no");
    state = answer(state, "A community token");
    state = answer(state, "greenharbor.example");
    state = answer(state, "@greenharbor");
    state = answer(state, "t.me/greenharbor");
    state = answer(state, "ETH");
    state = answer(state, "$25");
    state = answer(state, "holders");
    const waiting = prompt(advanceGuidedLaunch(state, "change it"));
    expect(waiting.state.phase).toBe("confirm");
    const result = advanceGuidedLaunch(state, "confirm");
    expect(result.kind).toBe("execute");
    if (result.kind !== "execute") return;
    expect(result.command).toMatchObject({
      kind: "launch", name: "Green Harbor", symbol: "GHRB",
      description: "A community token", website: "https://greenharbor.example",
      twitter: "https://x.com/greenharbor", telegram: "https://t.me/greenharbor",
      holderFeeSharing: true, devBuy: { amount: "25", unit: "usd" },
    });
    expect(result.commandText).toContain("holder fee sharing");
    expect(result.commandText).not.toContain("assign fees to");
  });

  it("round-trips only bounded valid persisted state", () => {
    const state = createGuidedLaunchState(true);
    expect(decodeGuidedLaunchState(JSON.stringify(state))).toEqual(state);
    expect(decodeGuidedLaunchState('{"version":2}')).toBeNull();
    expect(decodeGuidedLaunchState("x".repeat(8_001))).toBeNull();
  });

  it("accepts polite punctuation around launch controls", () => {
    let state = reachOptionalFields();
    for (let index = 0; index < 8; index += 1) state = answer(state, "No, thanks!");
    expect(state.phase).toBe("confirm");
    expect(advanceGuidedLaunch(state, "Yes please!").kind).toBe("execute");
  });
});
