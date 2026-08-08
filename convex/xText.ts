const URL_PATTERN = /https?:\/\/\S+/g;

/** X renders every HTTP(S) URL as a 23-character t.co link. */
export function xWeightedLength(text: string) {
  return text.replace(URL_PATTERN, "x".repeat(23)).length;
}

function truncateToWeight(text: string, budget: number) {
  if (xWeightedLength(text) <= budget) return text;
  const ellipsis = "…";
  let result = "";
  for (const character of text) {
    if (xWeightedLength(result + character + ellipsis) > budget) break;
    result += character;
  }
  return `${result.trimEnd()}${ellipsis}`;
}

/**
 * Fits a fully rendered response after dynamic names, tickers, amounts and
 * handles have been inserted. Link lines are retained intact whenever the
 * descriptive copy needs to be shortened.
 */
export function fitXReply(text: string, limit = 280) {
  const normalized = text.trim();
  if (xWeightedLength(normalized) <= limit) return normalized;

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const linkLines = lines.filter((line) => /https?:\/\/\S+/.test(line));
  const body = lines.filter((line) => !/https?:\/\/\S+/.test(line)).join(" ");
  const links = linkLines.join("\n");
  if (!links) return truncateToWeight(body, limit);

  const linkWeight = xWeightedLength(links);
  if (linkWeight >= limit) return truncateToWeight(links, limit);
  const bodyBudget = limit - linkWeight - 1;
  return `${truncateToWeight(body, bodyBudget)}\n${links}`;
}
