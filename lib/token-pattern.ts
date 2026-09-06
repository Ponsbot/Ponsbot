/**
 * Token names/symbols may contain Han, hiragana and katakana. English command
 * words remain English; addresses, URLs and account handles are NOT token
 * identifiers and must keep their own validators.
 *
 * Extend the existing ASCII token grammar without transliterating identifiers
 * or changing their identity. JS \b is ASCII-only, so token expressions also
 * need Unicode word boundaries (including when a ticker ends a sentence).
 */
const scripts = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC\\uFF70";
const word = "[\\p{L}\\p{M}\\p{N}_]";
const boundary = `(?:(?<!${word})(?=${word})|(?<=${word})(?!${word}))`;
const sources = new Map<string, string>();

export const tokenCharacterCount = (value: string) => Array.from(value).length;
export const sliceTokenText = (value: string, maximum: number) => Array.from(value).slice(0, maximum).join("");

export function tokenPattern(pattern: RegExp | string, flags?: string): RegExp {
  const source = typeof pattern === "string" ? pattern : pattern.source;
  const options = (flags ?? (typeof pattern === "string" ? "" : pattern.flags)).replace(/u/g, "") + "u";
  let expanded = sources.get(source);
  if (expanded === undefined) {
    expanded = source.replace(/(?<!\\)\[(\^?)((?:\\.|[^\]\\])+)\]/g, (whole, negative: string, body: string, offset: number) => {
      // These are token-letter classes. Classes immediately following @ and
      // hexadecimal address/transaction classes deliberately stay unchanged.
      if (!/(?:a-zA-Z|A-Za-z|A-Z|a-z)/.test(body)
        || /@\??$/.test(source.slice(0, offset))) return whole;
      const escaped = body.replace(/(?<!\\)-$/, "\\-").replace(/^-/, "\\-");
      return `[${negative}${escaped}${scripts}${body.includes("0-9") ? "\\p{M}" : ""}]`;
    }).replace(/\\b/g, boundary);
    if (sources.size < 512) sources.set(source, expanded);
  }
  // Return a fresh expression: global matchAll/test callers must not share
  // mutable lastIndex state.
  return new RegExp(expanded, options);
}
