import { http, type HttpTransportConfig } from "viem";

const RPC_ATTEMPTS = 5;
const RPC_BASE_DELAY_MS = 500;
const RPC_MAX_DELAY_MS = 4_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROVIDER_AUTH_STATUS = new Set([401, 403]);
const PUBLIC_ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const READ_FALLBACK_METHODS = new Set([
  "eth_blockNumber", "eth_call", "eth_chainId", "eth_estimateGas", "eth_feeHistory",
  "eth_gasPrice", "eth_getBalance", "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
  "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionByHash",
  "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas",
  "eth_syncing", "net_version", "web3_clientVersion",
]);
const PRIMARY_CIRCUIT_FAILURES = 2;
const PRIMARY_CIRCUIT_MS = 30_000;

let primaryAuthorizationFailures = 0;
let primaryCircuitUntil = 0;

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

function rpcMethods(init?: RequestInit) {
  if (typeof init?.body !== "string") return [];
  try {
    const parsed = JSON.parse(init.body) as { method?: unknown } | Array<{ method?: unknown }>;
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    return requests.map((request) => typeof request?.method === "string" ? request.method : "");
  } catch {
    return [];
  }
}

function isFallbackSafeRead(init?: RequestInit) {
  const methods = rpcMethods(init);
  return methods.length > 0 && methods.every((method) => READ_FALLBACK_METHODS.has(method));
}

function sameRpc(left: string, right: string) {
  return left.replace(/\/$/, "").toLowerCase() === right.replace(/\/$/, "").toLowerCase();
}

/**
 * Uses the configured provider first and Robinhood's public RPC only for
 * explicitly allowlisted, read-only JSON-RPC methods. Transaction submission
 * is intentionally excluded and remains under the signer's hash-reconciled
 * broadcast path.
 */
export function resilientRobinhoodHttp(url?: string, config: HttpTransportConfig = {}) {
  const primaryUrl = url || process.env.ROBINHOOD_RPC_URL || PUBLIC_ROBINHOOD_RPC_URL;
  if (sameRpc(primaryUrl, PUBLIC_ROBINHOOD_RPC_URL)) return reliableHttp(primaryUrl, config);

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const fallbackSafe = isFallbackSafeRead(init);
    if (fallbackSafe && Date.now() < primaryCircuitUntil) {
      return retryingRpcFetch(PUBLIC_ROBINHOOD_RPC_URL, init);
    }

    try {
      const response = await retryingRpcFetch(input, init);
      if (response.ok) {
        primaryAuthorizationFailures = 0;
        return response;
      }
      if (!fallbackSafe || (!PROVIDER_AUTH_STATUS.has(response.status) && !RETRYABLE_STATUS.has(response.status))) {
        return response;
      }
      if (PROVIDER_AUTH_STATUS.has(response.status)) {
        primaryAuthorizationFailures += 1;
        if (primaryAuthorizationFailures >= PRIMARY_CIRCUIT_FAILURES) primaryCircuitUntil = Date.now() + PRIMARY_CIRCUIT_MS;
      }
      await response.body?.cancel().catch(() => undefined);
      return retryingRpcFetch(PUBLIC_ROBINHOOD_RPC_URL, init);
    } catch (error) {
      if (!fallbackSafe) throw error;
      return retryingRpcFetch(PUBLIC_ROBINHOOD_RPC_URL, init);
    }
  };

  return http(primaryUrl, { ...config, fetchFn, retryCount: 0 });
}

export function reliableHttp(url?: string, config: HttpTransportConfig = {}) {
  return http(url, { ...config, fetchFn: retryingRpcFetch, retryCount: 0 });
}
