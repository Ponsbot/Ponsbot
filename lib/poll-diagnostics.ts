export class PollPreparationError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    super('Poll preparation failed', { cause });
  }
}
// Only fixed categories are persisted. Provider URLs, API keys, payloads and
// raw error messages never enter the diagnostics or public responses.
export function pollDiagnostic(stage: string, error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let i = 0; i < 5 && current instanceof Error; i++) {
    messages.push(current.message);
    current = current.cause;
  }
  const text = messages.join(' ');
  const category = /TOKEN_MISMATCH/.test(text) ? 'token-mismatch'
    : /429|rate.?limit|too many requests/i.test(text) ? 'provider-rate-limit'
    : /timeout|timed out|abort/i.test(text) ? 'provider-timeout'
    : /revert|zero data|returned no data/i.test(text) ? 'contract-read-rejected'
    : /metadata|symbol|decimals|supply/i.test(text) ? 'token-metadata-or-supply'
    : /pool|liquidity/i.test(text) ? 'pool-verification'
    : /block|historical|archive/i.test(text) ? 'historical-block'
    : /network|fetch|RPC|503|502/i.test(text) ? 'provider-unavailable'
    : 'unclassified';
  const known = ['token-resolution', 'metadata', 'main-pool', 'exclusion-balances', 'snapshot', 'minimum-holdings', 'rights', 'persist'];
  const actual = error instanceof PollPreparationError ? error.stage : stage;
  return `stage=${known.includes(actual) ? actual : 'snapshot'}; cause=${category}`;
}
