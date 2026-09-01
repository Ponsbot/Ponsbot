import { describe, expect, it } from "vitest";
import { mergeTerminalMessages, splitTerminalMessage } from "../lib/terminal-message";

describe("terminal message rendering", () => {
  it("replaces an optimistic sent message with its persisted record", () => {
    const optimistic = { role: "user" as const, messageType: "chat", text: "buy 1 PONSBOT", requestId: "terminal_1", createdAt: 100 };
    const persisted = { ...optimistic, createdAt: 101 };
    expect(mergeTerminalMessages([optimistic], [persisted])).toEqual([persisted]);
  });

  it("turns HTTPS response URLs into safe links without swallowing punctuation", () => {
    expect(splitTerminalMessage("Done: https://example.com/tx/123. Next")).toEqual([
      "Done: ", { url: "https://example.com/tx/123", suffix: "." }, " Next",
    ]);
  });

  it("keeps non-URL markup as escaped text", () => {
    expect(splitTerminalMessage('<script>alert("x")</script>')).toEqual(['<script>alert("x")</script>']);
  });
});
