type Message = { role: "system" | "user" | "assistant"; content: string };

export type JsonSchemaResponseFormat = {
  name: string;
  schema: Record<string, unknown>;
};

export class OpenRouterRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

export function isStructuredOutputAvailabilityError(error: unknown) {
  return error instanceof OpenRouterRequestError
    && (error.status === 404 || error.status === 400)
    && /no endpoints found that can handle the requested parameters|structured outputs?.*(?:not supported|unsupported|unavailable)|response_format.*(?:not supported|unsupported)/i.test(error.message);
}

export async function openRouter(messages: Message[], maxTokens: number, options: {
  timeoutMs?: number; temperature?: number; minimumCompletionTokens?: number;
  reasoningEffort?: string; providerSort?: string;
  jsonSchema?: JsonSchemaResponseFormat;
} = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENROUTER_TEXT_MODEL || "openai/gpt-5.6-luna",
      messages,
      max_tokens: Math.max(maxTokens, options.minimumCompletionTokens || 0),
      // Luna's structured-output endpoints currently reject temperature when
      // exact parameter support is required. The JSON schema constrains the
      // response, so omit temperature for structured requests.
      temperature: options.jsonSchema ? undefined : options.temperature ?? 0,
      reasoning: options.reasoningEffort ? { effort: options.reasoningEffort } : undefined,
      response_format: options.jsonSchema ? {
        type: "json_schema",
        json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
      } : undefined,
      provider: options.providerSort || options.jsonSchema ? {
        ...(options.providerSort ? { sort: options.providerSort } : {}),
        ...(options.jsonSchema ? { require_parameters: true } : {}),
      } : undefined,
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new OpenRouterRequestError(payload.error?.message || `OpenRouter failed (${response.status})`, response.status);
  return payload.choices?.[0]?.message?.content || "";
}

export function normalize(value: string, maxWords: number) {
  return value.trim().replace(/\s+/g, " ").split(" ").slice(0, maxWords).join(" ");
}
