/**
 * X rejects a post containing more than one distinct cashtag. Preserve the
 * first ticker (and repeated references to that same ticker), while rendering
 * later tickers as plain symbols. Dollar amounts such as $100 are untouched.
 */
export function xCashtagSafeText(text: string) {
  let retained: string | undefined;
  return text.replace(/(^|[^A-Za-z0-9_$])\$([A-Za-z][A-Za-z0-9_]{0,31})\b/g, (match, prefix: string, symbol: string) => {
    const normalized = symbol.toLowerCase();
    if (!retained) {
      retained = normalized;
      return match;
    }
    return retained === normalized ? match : `${prefix}${symbol}`;
  });
}
