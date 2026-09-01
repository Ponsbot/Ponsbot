import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouter } from "../convex/llm";
import { walletExtractionSchema, walletIntentSchema } from "../convex/xWalletAiSchemas";
import { parameterExtractorPrompt, parseXWalletIntent } from "../convex/xWalletIntent";

const originalApiKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_TEXT_MODEL;
const originalStructured = process.env.OPENROUTER_STRUCTURED_OUTPUTS_ENABLED;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENROUTER_TEXT_MODEL;
  else process.env.OPENROUTER_TEXT_MODEL = originalModel;
  if (originalStructured === undefined) delete process.env.OPENROUTER_STRUCTURED_OUTPUTS_ENABLED;
  else process.env.OPENROUTER_STRUCTURED_OUTPUTS_ENABLED = originalStructured;
});

describe("OpenRouter structured wallet outputs", () => {
  it("sends a strict schema and requires a provider that supports it", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_TEXT_MODEL = "openai/gpt-5.6-luna";
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"irrelevant","operation":null,"topic":null}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await openRouter([{ role: "user", content: "hello" }], 80, {
      providerSort: "latency",
      jsonSchema: walletIntentSchema,
    });

    expect(result).toContain('"irrelevant"');
    expect(requestBody?.model).toBe("openai/gpt-5.6-luna");
    expect(requestBody?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: walletIntentSchema.name, strict: true, schema: walletIntentSchema.schema },
    });
    expect(requestBody?.provider).toEqual({ sort: "latency", require_parameters: true });
    expect(requestBody?.temperature).toBeUndefined();
  });

  it("defines closed schemas for every specialized operation", () => {
    const operations = ["create_wallet", "show_wallet", "show_balance", "send", "burn", "buy", "buy_and_send", "buy_and_burn", "swap_token_for_token", "sell", "claim_fees", "reassign_fees", "upgrade_fees", "launch"];
    for (const operation of operations) {
      const responseFormat = walletExtractionSchema(operation);
      expect(responseFormat.name).toBe(`pons_bot_${operation}_parameters`);
      expect(responseFormat.schema).toMatchObject({ type: "object", additionalProperties: false });
      expect((responseFormat.schema.required as string[])).toContain("kind");
    }
  });

  it("rejects unknown operation schemas", () => {
    expect(() => walletExtractionSchema("not_real")).toThrow("Unsupported wallet extraction schema");
  });

  it("falls back to an unstructured AI attempt only after schema endpoint unavailability", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_STRUCTURED_OUTPUTS_ENABLED = "true";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "No endpoints found that can handle the requested parameters" } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"irrelevant"}' } }] }), { status: 200 });
    }));

    await expect(parseXWalletIntent("nice weather today", false)).resolves.toEqual({ kind: "irrelevant" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBeTruthy();
    expect(bodies[1].response_format).toBeUndefined();
  });

  it("does not permit a missing token to turn an explicit USD token send into ETH", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_STRUCTURED_OUTPUTS_ENABLED = "false";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const classifier = body.messages[0].content.startsWith("Classify one direct X post");
      const content = classifier
        ? '{"kind":"command","operation":"send"}'
        : '{"kind":"send","amount":"10","unit":"usd","recipient":"@alice"}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));

    await expect(parseXWalletIntent("send $10 of SNDK to @alice", false)).resolves.toEqual({
      kind: "command", command: { kind: "send", amount: "10", unit: "usd", token: "SNDK", recipient: "@alice" },
    });
  });

  it("keeps the prompt aligned with schema-invalid and USD-sell behavior", () => {
    expect(parameterExtractorPrompt("sell", false)).toContain('unit":"eth|usd|token|percent');
    expect(parameterExtractorPrompt("sell", false)).toContain("sell $25 of PONSBOT");
    expect(parameterExtractorPrompt("sell", false)).toContain("sell 0.001 ETH of PONS");
    expect(parameterExtractorPrompt("send", false)).toContain("set every unavailable property to null");
  });
});
