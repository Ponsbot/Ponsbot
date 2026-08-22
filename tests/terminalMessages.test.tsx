import { describe, expect, it } from "vitest";
import { splitTerminalMessage } from "../lib/terminal-message";

describe("terminal message rendering", () => {
  it("turns HTTPS response URLs into safe links without swallowing punctuation", () => {
    expect(splitTerminalMessage("Done: https://example.com/tx/123. Next")).toEqual([
      "Done: ", { url: "https://example.com/tx/123", suffix: "." }, " Next",
    ]);
  });

  it("keeps non-URL markup as escaped text", () => {
    expect(splitTerminalMessage('<script>alert("x")</script>')).toEqual(['<script>alert("x")</script>']);
  });
});
