import { describe, expect, it } from "vitest";
import { graduationAnnouncementText, graduationNextCheckAt, graduationTokenPageUrl } from "../lib/graduation-announcement";
import { xWeightedLength } from "../convex/xText";

describe("graduation announcements", () => {
  it("links to the Pons Bot token page and stays within X limits", () => {
    const url = graduationTokenPageUrl("0x1111111111111111111111111111111111111b07", "https://ponsbot.family/");
    const text = graduationAnnouncementText("$river", url);
    expect(url).toBe("https://ponsbot.family/launch/0x1111111111111111111111111111111111111b07");
    expect(text).toContain("🎓 $RIVER has graduated! 🚀");
    expect(text).toContain(url);
    expect(xWeightedLength(text)).toBeLessThanOrEqual(280);
  });

  it("backs inactive graduation checks off as a launch ages", () => {
    const now = 2_000_000_000;
    expect(graduationNextCheckAt(now - 30 * 60_000, now)).toBe(now + 2 * 60_000);
    expect(graduationNextCheckAt(now - 3 * 60 * 60_000, now)).toBe(now + 10 * 60_000);
    expect(graduationNextCheckAt(now - 2 * 24 * 60 * 60_000, now)).toBe(now + 60 * 60_000);
  });
});
