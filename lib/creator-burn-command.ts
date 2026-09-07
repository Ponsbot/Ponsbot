import { creatorBurnPercentageBps } from "./creator-burn-policy";
const TOKEN = "(?:0x[a-fA-F0-9]{40}|[\\p{L}\\p{N}\\p{M}_ーｰ]{1,32})";
const BURN = "(?:buy\\s*back|buyback)\\s+and\\s+burn";
export function parseCreatorBurnCommand(raw: string) {
  const text = raw.replace(/@ponsbotfamily\b/gi, " ").trim();
  const m =
    text.match(
      new RegExp(
        `^(?:reassign|assign|set)\\s+(\\d+(?:\\.\\d+)?)%\\s+of\\s+(?:\\$?(${TOKEN})\\s+(?:creator\\s+)?fees|(?:creator\\s+)?fees\\s+for\\s+\\$?(${TOKEN}))\\s+to\\s+${BURN}[.!]?$`,
        "iu",
      ),
    ) ??
    text.match(
      new RegExp(
        `^set\\s+(\\d+(?:\\.\\d+)?)%\\s+self[- ]burn\\s+for\\s+\\$?(${TOKEN})[.!]?$`,
        "iu",
      ),
    );
  if (!m) return null;
  try {
    return {
      kind: "reassign_fees" as const,
      token: m[2] || m[3],
      recipient: "self",
      selfBurnBps: creatorBurnPercentageBps(m[1]),
    };
  } catch {
    return {
      kind: "unknown" as const,
      reason:
        "⚠️ Choose a self-buyback-and-burn percentage from 0 to 100, with at most two decimal places.",
    };
  }
}
export function launchCreatorBurnOption(text: string) {
  const re = new RegExp(
    `\\b(?:assign|set)\\s+(\\d+(?:\\.\\d+)?)%\\s+of\\s+(?:creator\\s+)?fees\\s+to\\s+${BURN}\\b`,
    "gi",
  );
  const matches = [...text.matchAll(re)];
  if (matches.length > 1)
    throw new Error("Specify only one creator self-burn percentage.");
  return matches.length
    ? {
        bps: creatorBurnPercentageBps(matches[0][1]),
        text: text.replace(re, " "),
      }
    : { text };
}
