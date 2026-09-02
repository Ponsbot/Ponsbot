type XReference = { type: "replied_to" | "quoted" | "retweeted"; id: string };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Identifies replies where the bot is only an automatically carried member of
 * a leading participant block (or is absent from the direct text entirely).
 * A sole @Ponsbotfamily invocation, or another direct mention later in the
 * post, remains explicit.
 */
export function isPassiveBotChainReply(text: string, references: XReference[] | undefined, botUsername = "Ponsbotfamily") {
  if (!references?.some((reference) => reference.type === "replied_to")) return false;
  const bot = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "ig");
  const mentions = [...text.matchAll(bot)];
  if (!mentions.length) return true;
  const leading = text.trimStart().match(/^(?:@[A-Za-z0-9_]{1,15}(?:[\s,:-]+|$))+/)?.[0] || "";
  const leadingHandles = leading.match(/@[A-Za-z0-9_]{1,15}/g) || [];
  const distinctHandles = new Set(leadingHandles.map((handle) => handle.toLowerCase()));
  if (distinctHandles.size < 2 || !bot.test(leading)) return false;
  bot.lastIndex = 0;
  return !bot.test(text.trimStart().slice(leading.length));
}

/**
 * Launches require an explicit bot mention in the current post. In a reply,
 * the bot appearing only inside X's multi-participant prefix is inherited and
 * does not count; a sole leading invocation or a later mention does.
 */
export function hasExplicitBotMention(text: string, references: XReference[] | undefined, botUsername = "Ponsbotfamily") {
  if (!new RegExp(`@${escapeRegExp(botUsername)}\\b`, "i").test(text)) return false;
  return !isPassiveBotChainReply(text, references, botUsername);
}

/**
 * Launch authorization is satisfied by a direct invocation in the current
 * post or by the platform-verifiable fact that its direct parent is the bot.
 * Intent parsing must still classify the current post as a launch before this
 * authorization is consulted.
 */
export function launchPostAuthorized(
  text: string,
  references: XReference[] | undefined,
  botParentAuthorized: boolean,
  botUsername = "Ponsbotfamily",
) {
  return botParentAuthorized || hasExplicitBotMention(text, references, botUsername);
}

/**
 * Applies transaction/wallet-only reply handling to every deeper reply and to
 * any first-level reply where the bot is merely inherited from the thread.
 */
export function shouldRestrictChainReply(
  text: string,
  references: XReference[] | undefined,
  parentIsReply: boolean,
  botUsername = "Ponsbotfamily",
) {
  return parentIsReply || isPassiveBotChainReply(text, references, botUsername);
}
