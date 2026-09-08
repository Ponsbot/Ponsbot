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
  const normalized = directPostCommandText(text.normalize("NFKC"), botUsername)
    // A repeated invocation can also trail the control word. Remove only our
    // exact standalone handle here, not in general commands where it may be a
    // payment/fee recipient. Other handles and extra instructions still fail.
    .replace(new RegExp(`(^|[\\s.!?,;:])@${escapeRegExp(botUsername)}(?=$|[\\s.!?,;:])`, "gi"), " ")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+$/g, "")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length > 240 || /\b(?:not|dont|do not|stop|cancel|never|havent|hasnt|isnt|cant|cannot|later|tomorrow)\b/.test(normalized)) return false;
  const body = normalized.replace(/\bthank you\b/g, ' ').split(' ').filter(word => word && !['please', 'pls', 'plz', 'thanks', 'ok', 'okay', 'hey', 'hi'].includes(word)).join(' ');
  const action = "(?:(?:can|could|would) you |lets )?(?:resume|continue|proceed|retry|try again|go ahead)(?: (?:with )?(?:(?:my|the|this|that|same|previous|original) )*(?:launch|request|transaction|swap|trade|setup|position|it))?(?: now)?";
  const funded = "(?:(?:i|ive|i have|i just|ive just|i have now|i have already) )?(?:funded(?: (?:it|(?:(?:my|the) )?wallet))?|added|sent|deposited)(?: (?:the |some |more )?(?:eth|funds|gas|money))?(?: (?:to|into) (?:my |the )?wallet)?";
  const ready = `(?:yes|done|im done|i am done|i did it|did it|finished|all set|good to go|ready|im ready|i am ready|wallet funded|my wallet is funded|its funded|funds added|${funded})(?: now| already)?`;
  // The whole reply must be a funding acknowledgement and/or an instruction
  // to continue saved details. New amounts, recipients or trades do not match.
  return new RegExp(`^(?:${action}|${ready})(?: (?:and |so )?${action})?$`).test(body);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
