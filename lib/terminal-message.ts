export type TerminalMessagePart = string | { url: string; suffix: string };

export type TerminalMessageRecord = {
  role: "user" | "assistant";
  messageType: string;
  text: string;
  requestId?: string;
  createdAt: number;
};

function terminalMessageKey(message: TerminalMessageRecord) {
  return message.requestId
    ? `${message.requestId}:${message.role}`
    : `${message.role}:${message.createdAt}:${message.text}`;
}

export function mergeTerminalMessages(current: TerminalMessageRecord[], next: TerminalMessageRecord[]) {
  return [...new Map([...current, ...next].map((item) => [terminalMessageKey(item), item])).values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-40);
}

export function splitTerminalMessage(text: string): TerminalMessagePart[] {
  const parts: TerminalMessagePart[] = [];
  const pattern = /https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    let url = match[0]; let suffix = "";
    while (/[),.!?;:]$/.test(url)) { suffix = `${url.slice(-1)}${suffix}`; url = url.slice(0, -1); }
    parts.push({ url, suffix }); cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
