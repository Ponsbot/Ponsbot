/**
 * Removes X's automatically prepended reply-participant handles from the start
 * of a mention. Only the direct post body is returned; parent and quoted text
 * are never appended. A recipient handle later in the command is preserved.
 */
export function directPostCommandText(text: string, botUsername = "Ponsbotfamily") {
  const trimmed = text.trim();
  const leadingHandles = trimmed.match(/^(?:@[A-Za-z0-9_]{1,15}(?:[\s,:-]+|$))+/)?.[0];
  if (!leadingHandles || !new RegExp(`@${escapeRegExp(botUsername)}\\b`, "i").test(leadingHandles)) return trimmed;
  return trimmed.slice(leadingHandles.length).trimStart();
}

/** Control replies are matched against the user's body, not X's automatically
 * prepended reply-participant handles. */
export function isResumeReply(text: string, botUsername = "Ponsbotfamily") {
  const normalized = directPostCommandText(text, botUsername)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+$/g, "")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:please )?(?:resume|continue|proceed|retry|try again|go ahead|yes|done|im done|did it|finished|all set|good to go|ready|ready now|funded|funded it|wallet funded|its funded|i funded it|funds added|added (?:the )?(?:eth|funds)|sent (?:the )?eth|deposited (?:the )?eth)(?: please| now)?$/.test(normalized);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
