export type XReferenceType = "quoted" | "replied_to";

export type XPostReference = {
  id: string;
  type: "quoted" | "replied_to" | "retweeted";
};

const REFERENCE_IMAGE_PHRASE = /\b(?:use|using|with) this (?:image|picture)\b/i;
const NEGATED_REFERENCE_IMAGE_PHRASE = /\b(?:do not|don't|dont|not|never|without)\b[^.!?\n]{0,32}\b(?:use|using|with) this (?:image|picture)\b/i;
const DIRECT_IMAGE_INSTRUCTION = /\b(?:(?:ticker|symbol)\s*:?\s*)?(?:use|using|with) this (?:image|picture)\b(?:\s+(?:as|for)\s+(?:(?:a|the|my|our|your)\s+)?(?:token\s+)?logo\b)?(?:[.!]?\s+add your token logo\b[.!]?)?/gi;

function removeQuotedContent(text: string) {
  return text
    .replace(/"[^"\r\n]*"/g, " ")
    .replace(/'[^'\r\n]*'/g, " ")
    .replace(/“[^”\r\n]*”/g, " ")
    .replace(/‘[^’\r\n]*’/g, " ");
}

export function requestsReferencedLaunchImage(text: string) {
  const commandText = removeQuotedContent(text);
  return REFERENCE_IMAGE_PHRASE.test(commandText) && !NEGATED_REFERENCE_IMAGE_PHRASE.test(commandText);
}

/**
 * Image guidance is not launch metadata, whether the photo is attached or
 * referenced. Consume the whole instruction, including "as logo". A ticker
 * label immediately followed by this instruction has no value; the ordinary
 * name-only launch rule applies. Explicit ticker AS/USE/LOGO remains valid.
 * This does not change which photo may be fetched. Quoted metadata stays literal.
 */
export function stripDirectLaunchImageInstruction(text: string) {
  return text
    .split(/("[^"\r\n]*"|'[^'\r\n]*'|“[^”\r\n]*”|‘[^’\r\n]*’)/g)
    .map((part, index) => index % 2 ? part : part.replace(DIRECT_IMAGE_INSTRUCTION, " "))
    .join("")
    .replace(/^\s*(?:and\s+)?/i, "")
    .replace(/\s+(?:and\s*)?([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function selectLaunchImageReference(references: XPostReference[] | undefined): { id: string; type: XReferenceType } | undefined {
  if (!references?.length) return undefined;
  const selected = references.find((reference) => reference.type === "quoted")
    || references.find((reference) => reference.type === "replied_to");
  if (!selected || !/^\d+$/.test(selected.id)) return undefined;
  return { id: selected.id, type: selected.type as XReferenceType };
}

export function firstPhotoUrl(
  mediaKeys: string[] | undefined,
  media: Array<{ media_key: string; type: string; url?: string }> | undefined,
) {
  if (!mediaKeys?.length || !media?.length) return undefined;
  const byKey = new Map(media.map((item) => [item.media_key, item]));
  return mediaKeys.map((key) => byKey.get(key)).find((item) => item?.type === "photo" && item.url)?.url;
}
