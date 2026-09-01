import { afterEach, describe, expect, it, vi } from "vitest";
const ai = vi.hoisted(() => vi.fn());
vi.mock("../convex/llm", () => ({ openRouter: ai, isStructuredOutputAvailabilityError: () => false }));
import { parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { groundedCanonicalCommand, parseXWalletIntent, type AiWorkflowDiagnostics } from "../convex/xWalletIntent";
import { executionRequestSchema } from "../lib/wallet-signer/policy";
import { stripDirectLaunchImageInstruction } from "../lib/x-launch-image-policy";

const recipient = "0xac9bC2482bc9F4dD33161DA45dEc3516764D5DA3";
const tokenAddress = "0xF66977c74c1f7ec0D2b0C9E5Fb2D7C5B50f68b07";
afterEach(() => { vi.restoreAllMocks(); ai.mockReset(); });

describe("whole image instructions are not ticker values", () => {
  it.each(["as logo", "as the logo", "as my token logo", "for our logo", "as your logo"])("removes the suffix %s", suffix => {
    const post = `launch River ticker RIV use this image ${suffix}`;
    expect(stripDirectLaunchImageInstruction(post)).toBe("launch River ticker RIV");
    expect(groundedCanonicalCommand(post)).toMatchObject({ name: "River", symbol: "RIV" });
  });
  it.each([
    ["@Ponsbotfamily launch a token $TOAST TOSTA ticker Use this image as logo Add Your Token Logo.", "TOAST"],
    ["@Ponsbotfamily launch a token mosfik_eth ticker Use this image as logo", "MOSFIKETH"],
  ])("does not reuse image syntax in the observed request: %s", (post, symbol) => {
    expect(parseWalletCommand(post)).toMatchObject({ kind: "launch", symbol });
    expect(groundedCanonicalCommand(post)).toMatchObject({ kind: "launch", symbol });
  });
  it.each(["AS", "USE", "LOGO"])("keeps an intentionally supplied ticker %s", symbol => {
    expect(groundedCanonicalCommand(`launch River ticker ${symbol} use this image as logo`)).toMatchObject({ name: "River", symbol });
  });
  it("does not strip quoted names or descriptions", () => {
    const post = 'launch "Use This Image As Logo" ticker LOGO description "use this image as logo"';
    expect(stripDirectLaunchImageInstruction(post)).toBe(post);
    expect(groundedCanonicalCommand(post)).toMatchObject({ name: "Use This Image As Logo", symbol: "LOGO", description: "use this image as logo" });
  });
  it("does not remove standalone unquoted name words without image guidance", () => {
    const post = "launch Add Your Token Logo ticker LOGO";
    expect(stripDirectLaunchImageInstruction(post)).toBe(post);
  });
  it.each([true, false])("rejects a hallucinated AS even with hasImage=%s", async hasImage => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ai.mockResolvedValueOnce(JSON.stringify({ kind: "command", operation: "launch", topic: null }))
      .mockResolvedValue(JSON.stringify({ kind: "launch", launchMode: "pons", name: "River", symbol: "AS" }));
    const diagnostics: AiWorkflowDiagnostics = { classificationAttempts: [], extractionAttempts: [] };
    const result = await parseXWalletIntent("@Ponsbotfamily launch River ticker use this image as logo", hasImage, diagnostics);
    expect(result).toMatchObject({ kind: "command", command: { name: "River", symbol: "RIVER" } });
    expect(diagnostics.extractionAttempts).toHaveLength(2);
    expect(diagnostics.extractionAttempts.every(attempt => !attempt.accepted)).toBe(true);
  });
});

describe("ETH-denominated existing token quantities", () => {
  it.each([
    [`send 0.0018 ETH of GIGAPONS to ${recipient}`, "send", "GIGAPONS", recipient],
    ["send @alice 0.0018 ETH worth of $GIGAPONS", "send", "GIGAPONS", "@alice"],
    [`transfer 0.0018 eth of ${tokenAddress} to @alice please`, "send", tokenAddress, "@alice"],
    ["burn .0018 ETH of GIGAPONS", "burn", "GIGAPONS", undefined],
    ["burn 0.0018 ETH worth of $GIGAPONS", "burn", "GIGAPONS", undefined],
    [`burn 0.0018 ETH of ${tokenAddress}`, "burn", tokenAddress, undefined],
  ])("preserves the unit and target: %s", (post, kind, token, destination) => {
    const expected = { kind, amount: "0.0018", unit: "eth", token, ...(destination ? { recipient: destination } : {}) };
    expect(parseWalletCommand(post)).toMatchObject(expected);
    expect(groundedCanonicalCommand(post)).toMatchObject(expected);
    expect(validateStructuredWalletCommand(expected)).toMatchObject(expected);
  });
  it.each(["send", "burn"])("accepts the specialized AI's correct %s output on its first extraction", async kind => {
    const command = { kind, amount: "0.0018", unit: "eth", token: "GIGAPONS", ...(kind === "send" ? { recipient } : {}) };
    ai.mockResolvedValueOnce(JSON.stringify({ kind: "command", operation: kind, topic: null }))
      .mockResolvedValueOnce(JSON.stringify(command));
    const diagnostics: AiWorkflowDiagnostics = { classificationAttempts: [], extractionAttempts: [] };
    expect(await parseXWalletIntent(`${kind} 0.0018 ETH of GIGAPONS${kind === "send" ? ` to ${recipient}` : ""}`, false, diagnostics))
      .toMatchObject({ kind: "command", command });
    expect(diagnostics.source).toBe("ai_attempt_1");
    expect(diagnostics.extractionAttempts).toHaveLength(1);
    expect(diagnostics.extractionAttempts[0].accepted).toBe(true);
  });
  it("never accepts AI dropping the token and sending native ETH instead", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ai.mockResolvedValueOnce(JSON.stringify({ kind: "command", operation: "send", topic: null }))
      .mockResolvedValue(JSON.stringify({ kind: "send", amount: "0.0018", unit: "eth", recipient }));
    const diagnostics: AiWorkflowDiagnostics = { classificationAttempts: [], extractionAttempts: [] };
    expect(await parseXWalletIntent(`send 0.0018 ETH of GIGAPONS to ${recipient}`, false, diagnostics))
      .toMatchObject({ kind: "command", command: { kind: "send", unit: "eth", token: "GIGAPONS" } });
    expect(diagnostics.extractionAttempts.every(attempt => !attempt.accepted)).toBe(true);
    expect(diagnostics.extractionAttempts).toHaveLength(2);
  });
  it.each([
    ["send 0.0018 ETH to @alice", "send", "eth"],
    ["send $1 of GIGAPONS to @alice", "send", "usd"],
    ["send 10 GIGAPONS to @alice", "send", "token"],
    ["buy 0.0018 ETH of GIGAPONS", "buy", "eth"],
    ["sell 0.0018 ETH of GIGAPONS", "sell", "eth"],
    ["buy 0.0018 ETH of GIGAPONS and burn it", "buy_and_burn", "eth"],
    ["buy 0.0018 ETH of GIGAPONS and send it to @alice", "buy_and_send", "eth"],
  ])("preserves existing behavior: %s", (post, kind, unit) => {
    expect(groundedCanonicalCommand(post)).toMatchObject({ kind, unit });
  });
  it.each(["erc20_transfer", "erc20_burn_to_dead"])("allows ETH values through the strict signer schema: %s", type => {
    const operation = { type, ...(type === "erc20_transfer" ? { recipient } : { deadAddress: "0x000000000000000000000000000000000000dEaD" }),
      amount: "0.0018", unit: "eth", token: tokenAddress, quoterAddress: recipient, wethAddress: recipient,
      ponsFactoryAddress: recipient, v4QuoterAddress: recipient, fee: 10000 };
    const request = { chainId: 4663, ownerReference: "x:123456789", expectedFrom: recipient, walletRef: recipient, idempotencyKey: "offline-denomination", requireSimulation: true, operation };
    expect(executionRequestSchema.parse(request).operation).toEqual(operation);
    expect(executionRequestSchema.safeParse({ ...request, operation: { ...operation, unit: "pair" } }).success).toBe(false);
    expect(executionRequestSchema.safeParse({ ...request, operation: { ...operation, data: "0x" } }).success).toBe(false);
  });
  it.each([
    "send 0.001 ETH of to @alice", "send 0.001 ETH of @alice", "burn 0.001 ETH of",
  ])("does not default an incomplete token denomination to native ETH: %s", post => {
    expect(parseWalletCommand(post).kind).toBe("unknown");
    expect(groundedCanonicalCommand(post)).toBeNull();
  });
});
