import { describe, expect, it } from "vitest";
import { graduationAnnouncementText, graduationTokenPageUrl } from "../lib/graduation-announcement";
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
});
