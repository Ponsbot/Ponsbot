import {
  knownLaunchPairTicker,
  normalizeOptionalTelegramUrl,
  normalizeWebsiteUrl,
  normalizeXUrl,
  validateStructuredWalletCommand,
  type WalletCommand,
} from "../convex/walletCommands";
import { PUBLISHED_PAIR_SYMBOLS } from "./pair-catalog";

export type GuidedLaunchPhase =
  | "name"
  | "ticker"
  | "artwork"
  | "description"
  | "socials"
  // Retained so launch guides created before the combined-links rollout can
  // finish without losing their place.
  | "website"
  | "twitter"
  | "telegram"
  | "pair"
  | "dev_buy"
  | "fees"
  | "confirm";

type GuidedLaunchDraft = {
  name?: string;
  symbol?: string;
  imageUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  pairToken?: string;
  devBuy?: { amount: string; unit: "eth" | "usd" | "pair" };
  feeRecipient?: string;
  holderFeeSharing?: boolean;
};

export type GuidedLaunchState = {
  version: 1;
  phase: GuidedLaunchPhase;
  explicitMentionAuthorized: boolean;
  draft: GuidedLaunchDraft;
};

export type GuidedLaunchAdvance =
  | { kind: "prompt"; state: GuidedLaunchState; message: string; allowLong?: boolean }
  | { kind: "execute"; state: GuidedLaunchState; command: Extract<WalletCommand, { kind: "launch" }>; commandText: string; imageUrl?: string }
  | { kind: "cancelled"; message: string };

const SKIP = /^(?:no|none|skip|no thanks|not needed|nothing|skip this|no please)$/i;
const CONFIRM = /^(?:confirm|confirmed|please confirm|yes|yes please|yes launch|launch|launch it|go ahead|go ahead please|proceed|please proceed|do it)$/i;
const CANCEL = /^(?:cancel|cancel this|stop|stop this|never mind|nevermind|no|no thanks)$/i;
const EXPLICIT_CANCEL = /^(?:cancel|cancel this|stop|stop this|never mind|nevermind)$/i;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HANDLE = /^@[a-zA-Z0-9_]{1,15}$/;

function clean(text: string) {
  return text
    .replace(/^(?:@[A-Za-z0-9_]{1,15}[\s,:-]+)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function controlText(text: string) {
  return clean(text)
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/^(?:please\s+)+/i, "")
    .replace(/\s+(?:please|thanks|thank you)$/i, "")
    .replace(/[\s.!?,;:]+$/, "")
    .trim();
}

function unwrap(text: string) {
  return clean(text).replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
}

function safeText(text: string, maximum: number) {
  return unwrap(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function isQuestion(text: string, phase: GuidedLaunchPhase) {
  const value = clean(text);
  if (/^(?:what does (?:this|that|it) mean|can you explain|could you explain|please explain|tell me more|help me understand)\b/i.test(value)) return true;
  // Names and tickers may themselves be ordinary question-like words. Only
  // explicit requests for an explanation pause those two required fields.
  if (phase === "name" || phase === "ticker") return false;
  return /\?$/.test(value) && /\b(?:mean|explain|work|difference|option|choice|supported|available)\b/i.test(value);
}

export function guidedLaunchRequested(text: string) {
  const value = clean(text).replace(/[.!?]+$/, "");
  return /^(?:launch|launch on pons(?: v2)?|start|please start|(?:please )?get started|let(?:'|’)?s start|let(?:'|’)?s get (?:start|started)|let(?:'|’)?s get this started|launch a token|launch a coin|create a token|create a coin|deploy a token|deploy a coin|i (?:want|would like) to (?:launch|create|deploy)(?: a token| a coin)?(?: on pons(?: v2)?)?|help me (?:launch|create|deploy)(?: a token| a coin)?(?: on pons(?: v2)?)?|yes|yeah|yep|sure|ok(?:ay)?|go ahead|proceed|do it|let(?:'|’)?s do it)$/i.test(value);
}

export function createGuidedLaunchState(explicitMentionAuthorized: boolean): GuidedLaunchState {
  return { version: 1, phase: "name", explicitMentionAuthorized, draft: {} };
}

export function decodeGuidedLaunchState(value?: string): GuidedLaunchState | null {
  if (!value || value.length > 8_000) return null;
  try {
    const parsed = JSON.parse(value) as GuidedLaunchState;
    if (parsed.version !== 1 || ![
      "name", "ticker", "artwork", "description", "website", "twitter", "telegram", "pair", "dev_buy", "fees", "confirm",
      "socials",
    ].includes(parsed.phase) || !parsed.draft || typeof parsed.draft !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function guidedLaunchPrompt(phase: GuidedLaunchPhase) {
  const prompts: Record<GuidedLaunchPhase, string> = {
    name: "🚀 First, what is the token name? I’ll ask for the ticker separately next.",
    ticker: "🏷️ Now provide the token ticker. You can include or omit the $.",
    artwork: "🖼️ Would you like to add artwork? Attach one image in your reply, or reply “no.”",
    description: "📝 Would you like to add a description? Reply with it, or say “no.”",
    socials: "🌐 Add a website, X profile, and/or Telegram link. Label each one as Website:, X:, or Telegram:, or say “no.”",
    website: "🌐 Would you like to add a website? Reply with the URL, or say “no.”",
    twitter: "𝕏 Would you like to add an X profile? Reply with the X handle or profile URL, or say “no.”",
    telegram: "✈️ Would you like to add Telegram? Reply with a t.me/XXXXX link, or say “no.”",
    pair: "🔗 What should this token be paired with? Reply with ETH or a supported pairing asset, or say “no” for ETH.",
    dev_buy: "💰 Would you like a developer buy? Reply with an amount such as “$100,” “0.02 ETH,” or an amount of the paired asset, or say “no.”",
    fees: "💸 Would you like to assign future creator fees to another X user or wallet, or share them with holders? Reply with @user, a wallet address, “holders,” or “no.”",
    confirm: "Reply “confirm” to launch, or “cancel.”",
  };
  return prompts[phase];
}

function explanation(phase: GuidedLaunchPhase) {
  const explanations: Record<GuidedLaunchPhase, string> = {
    name: "The token name is its full display name.",
    ticker: "The ticker is the short symbol shown with the token. It can contain up to 16 letters or numbers.",
    artwork: "Artwork is optional website imagery for the token. Attach it directly to this reply; it is not required for launch.",
    description: "The description is optional text shown with the token and can contain up to 280 characters.",
    socials: "Project links are optional. Websites are normalized to HTTPS, X must be an @handle or profile URL, and Telegram must use a t.me/XXXXX link.",
    website: "The optional website must be a public web address. It will be normalized to HTTPS.",
    twitter: "The optional X link must identify one X profile, either as @user or an x.com profile URL.",
    telegram: "The optional Telegram link must use the t.me/XXXXX format. A bare @handle is not accepted.",
    pair: `ETH is the default pairing asset. Supported Pons V2 pairing assets are ${PUBLISHED_PAIR_SYMBOLS.join(", ")}.`,
    dev_buy: "A developer buy purchases tokens for your Pons Bot wallet in the launch transaction. It is optional and uses your wallet funds.",
    fees: "By default, 95% of creator fees go to your Pons Bot wallet and 5% buys back and burns $PONSBOT. If fees are reassigned, that 95% goes to the assigned wallet or holders, and the new assignee controls future reassignment.",
    confirm: "Confirmation submits the launch using the details shown. A launch is an on-chain action and cannot be undone.",
  };
  return explanations[phase];
}

function pairedAssetsQuestion(text: string) {
  const value = clean(text);
  return /^(?:(?:what|which|list|show|give)\b[\s\S]{0,45}\b(?:pair(?:ed|ing)?\s+assets?|assets?\s+(?:can\s+i\s+)?(?:use\s+)?(?:for\s+)?pairing)\b|(?:what|which)\s+can\s+i\s+pair\s+(?:it\s+)?with\b|what\s+are\s+the\s+(?:pair(?:ed|ing)?\s+)?options\b)/i.test(value);
}

function pairedAssetsAnswer(phase: GuidedLaunchPhase) {
  return `🔗 Supported Pons V2 pairing assets are ${PUBLISHED_PAIR_SYMBOLS.join(", ")}.\n\n${guidedLaunchPrompt(phase)}`;
}

function parseGuidedSocials(text: string) {
  const value = unwrap(text);
  const websiteRaw = value.match(/\b(?:website|site)\s*(?:is|=|:)?\s*((?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s,;]*)?)/i)?.[1];
  const twitterRaw = value.match(/\b(?:x|twitter)(?:\s+profile|\s+link)?\s*(?:is|=|:)?\s*(@[a-zA-Z0-9_]{1,15}|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]{1,15}\/?)/i)?.[1];
  const telegramRaw = value.match(/\b(?:telegram|tg)(?:\s+link)?\s*(?:is|=|:)?\s*((?:https?:\/\/)?(?:www\.)?t\.me\/[a-zA-Z0-9_]{1,64}|@[^\s,;]+|[^\s,;]+)/i)?.[1];
  const hasWebsiteLabel = /\b(?:website|site)\s*(?:is|=|:)/i.test(value);
  const hasXLabel = /\b(?:x|twitter)(?:\s+profile|\s+link)?\s*(?:is|=|:)/i.test(value);
  const hasTelegramLabel = /\b(?:telegram|tg)(?:\s+link)?\s*(?:is|=|:)/i.test(value);
  let website: string | undefined, twitter: string | undefined, telegram: string | undefined;
  try { if (websiteRaw) website = normalizeWebsiteUrl(websiteRaw); }
  catch { return { error: "⚠️ That website URL is not valid. Correct it, remove it, or say “no.”" }; }
  try { if (twitterRaw) twitter = normalizeXUrl(twitterRaw); }
  catch { return { error: "⚠️ That X profile is not valid. Use @user or an x.com profile URL." }; }
  if (hasWebsiteLabel && !websiteRaw) return { error: "⚠️ That website URL is not valid. Correct it, remove it, or say “no.”" };
  if (hasXLabel && !twitterRaw) return { error: "⚠️ That X profile is not valid. Use @user or an x.com profile URL." };
  if (telegramRaw) telegram = normalizeOptionalTelegramUrl(telegramRaw);
  const telegramOmitted = hasTelegramLabel && !telegram;

  // A single unlabeled link remains convenient while multiple values require
  // labels so one social cannot be stored in another field.
  if (!website && !twitter && !telegram && !hasWebsiteLabel && !hasXLabel && !hasTelegramLabel) {
    if (/^@[a-zA-Z0-9_]{1,15}$/.test(value) || /^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]{1,15}\/?$/i.test(value)) {
      try { twitter = normalizeXUrl(value); } catch { /* handled below */ }
    } else if (/^(?:https?:\/\/)?(?:www\.)?t\.me\/[a-zA-Z0-9_]{1,64}\/?$/i.test(value)) telegram = normalizeOptionalTelegramUrl(value);
    else {
      try { website = normalizeWebsiteUrl(value); } catch { /* handled below */ }
    }
  }
  if (!website && !twitter && !telegram && !telegramOmitted) return { error: "⚠️ Add at least one valid Website:, X:, or Telegram: link, or say “no.”" };
  return { website, twitter, telegram, telegramOmitted };
}

function next(state: GuidedLaunchState, phase: GuidedLaunchPhase, messagePrefix?: string): GuidedLaunchAdvance {
  const updated = { ...state, phase };
  const message = `${messagePrefix ? `${messagePrefix.trim()}\n\n` : ""}${guidedLaunchPrompt(phase)}`;
  return { kind: "prompt", state: updated, message };
}

function parseTicker(text: string) {
  const ticker = unwrap(text).replace(/^\$/, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return /^[A-Z0-9]{1,16}$/.test(ticker) ? ticker : undefined;
}

function parseDevBuy(text: string, pairToken?: string) {
  const value = clean(text).replace(/,/g, "");
  if (SKIP.test(value) || /^(?:0|\$0|0(?:\.0+)?\s*(?:ETH|USD)?)$/i.test(value)) return null;
  const usd = value.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/) || value.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:USD|dollars?)$/i);
  if (usd && Number(usd[1]) > 0) return { amount: usd[1], unit: "usd" as const };
  const eth = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:ETH|WETH)$/i);
  if (eth && Number(eth[1]) > 0) return { amount: eth[1], unit: "eth" as const };
  const pair = value.match(/^([0-9]+(?:\.[0-9]+)?)\s+\$?([a-zA-Z][a-zA-Z0-9]{0,31})$/);
  if (pair && Number(pair[1]) > 0 && pairToken && pairToken.toLowerCase() !== "eth"
    && (knownLaunchPairTicker(pair[2]) || pair[2]).toLowerCase() === pairToken.toLowerCase()) {
    return { amount: pair[1], unit: "pair" as const };
  }
  return undefined;
}

function displayValue(value: string) {
  return value.replace(/@[A-Za-z0-9_]{1,15}/g, match => `＠${match.slice(1)}`);
}

function launchCommand(state: GuidedLaunchState) {
  const raw = {
    kind: "launch",
    launchMode: "pons",
    name: state.draft.name,
    symbol: state.draft.symbol,
    description: state.draft.description,
    website: state.draft.website,
    twitter: state.draft.twitter,
    telegram: state.draft.telegram,
    pairToken: state.draft.pairToken,
    devBuy: state.draft.devBuy,
    feeRecipient: state.draft.feeRecipient,
    holderFeeSharing: state.draft.holderFeeSharing,
  };
  const command = validateStructuredWalletCommand(raw);
  return command?.kind === "launch" ? command : null;
}

function commandText(command: Extract<WalletCommand, { kind: "launch" }>) {
  const quoted = (value: string) => `“${value.replace(/[“”]/g, '"')}”`;
  const parts = [`launch ${quoted(command.name)}`, `ticker ${quoted(command.symbol)}`];
  if (command.description) parts.push(`description ${quoted(command.description)}`);
  if (command.website) parts.push(`website: ${command.website}`);
  if (command.twitter) parts.push(`X: ${command.twitter}`);
  if (command.telegram) parts.push(`Telegram: ${command.telegram}`);
  if (command.pairToken) parts.push(`pair with ${command.pairToken}`);
  if (command.devBuy) parts.push(command.devBuy.unit === "usd" ? `dev buy $${command.devBuy.amount}`
    : command.devBuy.unit === "eth" ? `dev buy ${command.devBuy.amount} ETH`
      : `dev buy ${command.devBuy.amount} ${command.pairToken}`);
  if (command.feeRecipient) parts.push(`assign fees to ${command.feeRecipient}`);
  if (command.holderFeeSharing) parts.push("holder fee sharing");
  return parts.join(", ");
}

function summary(state: GuidedLaunchState) {
  const d = state.draft;
  const rows = [
    "🚀 Review your Pons V2 launch:",
    "",
    `Name: ${displayValue(d.name || "")}`,
    `Ticker: $${d.symbol}`,
    `Artwork: ${d.imageUrl ? "Included" : "None"}`,
    `Description: ${d.description ? displayValue(d.description) : "None"}`,
    `Website: ${d.website || "None"}`,
    `X: ${d.twitter || "None"}`,
    `Telegram: ${d.telegram || "None"}`,
    `Pair: ${d.pairToken || "ETH"}`,
    `Developer buy: ${d.devBuy ? `${d.devBuy.unit === "usd" ? "$" : ""}${d.devBuy.amount}${d.devBuy.unit === "eth" ? " ETH" : d.devBuy.unit === "pair" ? ` ${d.pairToken}` : ""}` : "None"}`,
    `Creator fees: ${d.holderFeeSharing ? "Shared with holders" : d.feeRecipient ? `Assigned to ${d.feeRecipient}` : "Your Pons Bot wallet"}`,
    "",
    guidedLaunchPrompt("confirm"),
  ];
  return rows.join("\n");
}

export function advanceGuidedLaunch(
  state: GuidedLaunchState,
  text: string,
  mediaUrl?: string,
): GuidedLaunchAdvance {
  const value = clean(text);
  const control = controlText(text);
  const draft = { ...state.draft, ...(mediaUrl ? { imageUrl: mediaUrl } : {}) };
  const current = { ...state, draft };
  if (EXPLICIT_CANCEL.test(control)) return { kind: "cancelled", message: "Guided launch cancelled." };
  if (pairedAssetsQuestion(value)) return { kind: "prompt", state: current, message: pairedAssetsAnswer(state.phase) };
  if (isQuestion(value, state.phase)) return { kind: "prompt", state: current, message: `${explanation(state.phase)}\n\n${guidedLaunchPrompt(state.phase)}` };

  if (state.phase === "name") {
    const name = safeText(value.replace(/^(?:name|token name)\s*(?:is|=|:)?\s*/i, ""), 48);
    if (!name || /^https?:\/\//i.test(name) || /^@[a-zA-Z0-9_]+$/.test(name)) return next(current, "name", "⚠️ Please provide a valid token name.");
    return next({ ...current, draft: { ...draft, name } }, "ticker");
  }
  if (state.phase === "ticker") {
    const symbol = parseTicker(value.replace(/^(?:ticker|symbol)\s*(?:is|=|:)?\s*/i, ""));
    if (!symbol) return next(current, "ticker", "⚠️ Use a ticker containing 1 to 16 letters or numbers.");
    return next({ ...current, draft: { ...draft, symbol } }, draft.imageUrl ? "description" : "artwork");
  }
  if (state.phase === "artwork") {
    if (draft.imageUrl) return next(current, "description");
    if (SKIP.test(control)) return next(current, "description");
    return next(current, "artwork", "⚠️ Attach one image to your reply, or say “no.”");
  }
  if (state.phase === "description") {
    const description = SKIP.test(control) ? undefined : safeText(value.replace(/^(?:description|desc)\s*(?:is|=|:)?\s*/i, ""), 280);
    if (!SKIP.test(control) && !description) return next(current, "description", "⚠️ Reply with a description, or say “no.”");
    return next({ ...current, draft: { ...draft, ...(description ? { description } : {}) } }, "socials");
  }
  if (state.phase === "socials") {
    if (SKIP.test(control)) return next(current, "pair");
    const parsed = parseGuidedSocials(value);
    if (parsed.error) return next(current, "socials", parsed.error);
    const updated = { ...current, draft: { ...draft,
      ...(parsed.website ? { website: parsed.website } : {}),
      ...(parsed.twitter ? { twitter: parsed.twitter } : {}),
      ...(parsed.telegram ? { telegram: parsed.telegram } : {}),
    } };
    return next(updated, "pair", parsed.telegramOmitted ? "⚠️ That Telegram link was not usable, so it was omitted." : undefined);
  }
  if (state.phase === "website") {
    if (SKIP.test(control)) return next(current, "twitter");
    try {
      const website = normalizeWebsiteUrl(value.replace(/^(?:website|site)\s*(?:is|=|:)?\s*/i, ""));
      return next({ ...current, draft: { ...draft, website } }, "twitter");
    } catch {
      return next(current, "website", "⚠️ That website URL is not valid. Reply with a public website URL, or say “no.”");
    }
  }
  if (state.phase === "twitter") {
    if (SKIP.test(control)) return next(current, "telegram");
    try {
      const twitter = normalizeXUrl(value.replace(/^(?:x|twitter)(?:\s+link)?\s*(?:is|=|:)?\s*/i, ""));
      return next({ ...current, draft: { ...draft, twitter } }, "telegram");
    } catch {
      return next(current, "twitter", "⚠️ That X profile is not valid. Reply with @user or an x.com profile URL, or say “no.”");
    }
  }
  if (state.phase === "telegram") {
    if (SKIP.test(control)) return next(current, "pair");
    const telegram = normalizeOptionalTelegramUrl(value.replace(/^(?:telegram|tg)\s*(?:is|=|:)?\s*/i, ""));
    return next({ ...current, draft: { ...draft, ...(telegram ? { telegram } : {}) } }, "pair",
      telegram ? undefined : "⚠️ That Telegram link was not usable, so it was omitted.");
  }
  if (state.phase === "pair") {
    const supplied = unwrap(value.replace(/^(?:paired\s+(?:with|to)|pair\s+it\s+(?:with|to)|pair\s+with|as\s+the\s+pair|with\s+(?:the\s+)?asset\s+pair|pairing\s+asset|pair)\s*(?:is|=|:)?\s*/i, "")).replace(/^\$/, "");
    if (SKIP.test(control) || /^ETH$/i.test(supplied)) return next({ ...current, draft: { ...draft, pairToken: undefined } }, "dev_buy");
    const pairToken = ADDRESS.test(supplied) ? supplied : knownLaunchPairTicker(supplied) || supplied.toUpperCase();
    if (!ADDRESS.test(pairToken) && !PUBLISHED_PAIR_SYMBOLS.some(symbol => symbol.toLowerCase() === pairToken.toLowerCase())) {
      return next(current, "pair", "⚠️ That pairing asset is not currently supported. Reply with a supported pairing ticker, or say “no” for ETH.");
    }
    return next({ ...current, draft: { ...draft, pairToken } }, "dev_buy");
  }
  if (state.phase === "dev_buy") {
    const devBuy = SKIP.test(control)
      ? null
      : parseDevBuy(value.replace(/^(?:dev(?:eloper)? buy)\s*(?:is|=|:)?\s*/i, ""), draft.pairToken || "ETH");
    if (devBuy === undefined) return next(current, "dev_buy", `⚠️ Include USD, ETH, or ${draft.pairToken || "the paired asset"} with the amount, or say “no.”`);
    return next({ ...current, draft: { ...draft, ...(devBuy ? { devBuy } : {}) } }, "fees");
  }
  if (state.phase === "fees") {
    if (SKIP.test(control)) return { kind: "prompt", state: { ...current, phase: "confirm" }, message: summary(current), allowLong: true };
    if (/^(?:holders|holder fee sharing|share with holders|assign fees to holders|fees to holders)$/i.test(control)) {
      const updated = { ...current, phase: "confirm" as const, draft: { ...draft, holderFeeSharing: true, feeRecipient: undefined } };
      return { kind: "prompt", state: updated, message: summary(updated), allowLong: true };
    }
    const recipient = value.match(/@[a-zA-Z0-9_]{1,15}|0x[a-fA-F0-9]{40}/)?.[0];
    if (!recipient || (!HANDLE.test(recipient) && !ADDRESS.test(recipient))) {
      return next(current, "fees", "⚠️ Reply with an X handle, wallet address, “holders,” or “no.”");
    }
    const updated = { ...current, phase: "confirm" as const, draft: { ...draft, feeRecipient: recipient, holderFeeSharing: undefined } };
    return { kind: "prompt", state: updated, message: summary(updated), allowLong: true };
  }
  if (CANCEL.test(control)) return { kind: "cancelled", message: "Guided launch cancelled." };
  if (!CONFIRM.test(control)) return { kind: "prompt", state: current, message: summary(current), allowLong: true };
  const command = launchCommand(current);
  if (!command) return { kind: "prompt", state: current, message: "⚠️ I couldn’t validate those launch details. Reply “cancel” and start the guided launch again." };
  return { kind: "execute", state: current, command, commandText: commandText(command), imageUrl: draft.imageUrl };
}
