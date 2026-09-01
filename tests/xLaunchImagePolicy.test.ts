import { describe, expect, it } from "vitest";
import { firstPhotoUrl, requestsReferencedLaunchImage, selectLaunchImageReference, stripDirectLaunchImageInstruction } from "../lib/x-launch-image-policy";

describe("referenced launch image phrase policy", () => {
  it.each([
    "launch Pons Bot ticker PONSBOT use this image",
    "launch Pons Bot ticker PONSBOT use this picture",
    "launch Pons Bot ticker PONSBOT using this image",
    "launch Pons Bot ticker PONSBOT using this picture",
    "launch Pons Bot ticker PONSBOT with this image",
    "LAUNCH Pons Bot TICKER PONSBOT WITH THIS PICTURE please",
  ])("accepts the exact allowlisted wording: %s", (text) => {
    expect(requestsReferencedLaunchImage(text)).toBe(true);
  });

  it.each([
    "launch Pons Bot ticker PONSBOT use an image",
    "launch Pons Bot ticker PONSBOT use this imagery",
    "this image looks good, launch Pons Bot ticker PONSBOT",
    "launch Pons Bot ticker PONSBOT and attach the photo",
    "launch Pons Bot ticker PONSBOT without using this image",
    "launch Pons Bot ticker PONSBOT do not use this picture",
    "launch Pons Bot ticker PONSBOT don't use this image",
    "launch Pons Bot ticker PONSBOT never use this picture",
  ])("rejects near matches and negations: %s", (text) => {
    expect(requestsReferencedLaunchImage(text)).toBe(false);
  });

  it("ignores an allowlisted phrase inside metadata quotes", () => {
    expect(requestsReferencedLaunchImage('launch Pons Bot ticker PONSBOT description "use this image"')).toBe(false);
    expect(requestsReferencedLaunchImage("launch ‘Use This Image’ ticker IMAGE")).toBe(false);
  });
});

describe("referenced launch image source policy", () => {
  it("prefers a quote over a reply regardless of array order", () => {
    expect(selectLaunchImageReference([
      { type: "replied_to", id: "111" },
      { type: "quoted", id: "222" },
    ])).toEqual({ type: "quoted", id: "222" });
  });

  it("uses a reply when there is no quote and ignores retweets", () => {
    expect(selectLaunchImageReference([
      { type: "retweeted", id: "111" },
      { type: "replied_to", id: "222" },
    ])).toEqual({ type: "replied_to", id: "222" });
  });

  it("rejects malformed or unsupported references", () => {
    expect(selectLaunchImageReference([{ type: "quoted", id: "not-an-id" }])).toBeUndefined();
    expect(selectLaunchImageReference([{ type: "retweeted", id: "111" }])).toBeUndefined();
  });

  it("selects only a photo attached to the referenced post", () => {
    const media = [
      { media_key: "video", type: "video", url: "https://pbs.twimg.com/video.jpg" },
      { media_key: "photo", type: "photo", url: "https://pbs.twimg.com/photo.jpg" },
    ];
    expect(firstPhotoUrl(["video", "photo"], media)).toBe("https://pbs.twimg.com/photo.jpg");
    expect(firstPhotoUrl(["video"], media)).toBeUndefined();
  });
});

describe("direct launch image instruction", () => {
  it.each([
    ["use this image and launch Signal Bloom ticker BLOOM", "launch Signal Bloom ticker BLOOM"],
    ["launch Signal Bloom ticker BLOOM with this image", "launch Signal Bloom ticker BLOOM"],
    ["launch Signal Bloom ticker BLOOM, using this picture", "launch Signal Bloom ticker BLOOM,"],
  ])("removes attached-media guidance before command parsing", (text, expected) => {
    expect(stripDirectLaunchImageInstruction(text)).toBe(expected);
  });

  it("preserves the same words inside quoted metadata", () => {
    expect(stripDirectLaunchImageInstruction('launch Signal Bloom ticker BLOOM description "use this image" with this image'))
      .toBe('launch Signal Bloom ticker BLOOM description "use this image"');
  });
});
