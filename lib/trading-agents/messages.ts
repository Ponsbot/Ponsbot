/** Concise, deterministic description excerpt. Original personality stays unchanged. */
export function botCreationSummary(description: string) {
  const clean = description.normalize("NFC")
    .replace(/(?:https?:\/\/|www\.)\S+/giu, "")
    .replace(/[@#$]/gu, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!clean) return "A new personality for the Bot Yard.";
  const chars = Array.from(clean);
  if (chars.length <= 180) return clean;
  const excerpt = chars.slice(0, 177).join("");
  const boundary = excerpt.lastIndexOf(" ");
  return `${boundary >= 120 ? excerpt.slice(0, boundary) : excerpt}…`;
}

export function botCreatedReply(name: string, description: string) {
  const safeName = name.replace(/[@#$\p{Cc}\p{Cf}]/gu, "").trim();
  return `🤖 ${safeName} has been created!\n\n${botCreationSummary(description)}\n\nMeet your bot in the Bot Yard:\nhttps://www.ponsbot.family/bot-yard`;
}
