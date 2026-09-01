import { http, type HttpTransportConfig } from "viem";

const RPC_ATTEMPTS = 5;
const RPC_BASE_DELAY_MS = 500;
const RPC_MAX_DELAY_MS = 4_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response: Response | undefined, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, RPC_MAX_DELAY_MS);
  return Math.min(RPC_BASE_DELAY_MS * 2 ** attempt, RPC_MAX_DELAY_MS);
}

async function wait(ms: number, signal?: AbortSignal | null) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}

/** Bounded retries for transient RPC throttling, gateway failures, and network errors. */
export async function retryingRpcFetch(input: RequestInfo | URL, init?: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === RPC_ATTEMPTS - 1) return response;
      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelay(response, attempt), init?.signal);
    } catch (error) {
      lastError = error;
      if (init?.signal?.aborted || attempt === RPC_ATTEMPTS - 1) throw error;
      await wait(retryDelay(undefined, attempt), init?.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RPC request failed after retries");
}

export function reliableHttp(url?: string, config: HttpTransportConfig = {}) {
  return http(url, { ...config, fetchFn: retryingRpcFetch, retryCount: 0 });
}
