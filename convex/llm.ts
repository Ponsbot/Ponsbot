type Message = { role: "system" | "user" | "assistant"; content: string };

export async function openRouter(messages: Message[], maxTokens: number, options: {
  timeoutMs?: number; temperature?: number; minimumCompletionTokens?: number;
  reasoningEffort?: string; providerSort?: string;
} = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENROUTER_TEXT_MODEL || "openai/gpt-oss-20b",
      messages,
      max_tokens: Math.max(maxTokens, options.minimumCompletionTokens || 0),
      temperature: options.temperature ?? 0,
      reasoning: options.reasoningEffort ? { effort: options.reasoningEffort } : undefined,
      provider: options.providerSort ? { sort: options.providerSort } : undefined,
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `OpenRouter failed (${response.status})`);
  return payload.choices?.[0]?.message?.content || "";
}

export function normalize(value: string, maxWords: number) {
  return value.trim().replace(/\s+/g, " ").split(" ").slice(0, maxWords).join(" ");
}
