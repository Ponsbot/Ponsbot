export function isUnavailableFeeBlock(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /header not(?: found| available)?\b|unknown block|block (?:not found|not available)|cannot find.*block|missing trie node|historical state.*unavailable/i.test(message);
}

/** Restart the entire read-only snapshot; never mix fields from different blocks. */
export async function retryFeeInspection<T>(inspect: (attempt: number) => Promise<T>,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await inspect(attempt); }
    catch (error) {
      if (!isUnavailableFeeBlock(error) || attempt >= 2) throw error;
      await pause(750 * (attempt + 1));
    }
  }
}
