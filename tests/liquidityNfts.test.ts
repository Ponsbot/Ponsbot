import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { extractLiquidityFields } from "../convex/liquidityAi";
import { liquidityNftLines } from "../lib/liquidity-nfts";
import { DELTA_LIQUIDITY, isLiquidityMessage, liquidityNftSelection, newLiquidityDraft } from "../lib/liquidity-workflow";
import { paginateLiquidityResponse } from "../lib/liquidity-responses";
afterEach(() => vi.clearAllMocks());
const position = { publicId: "LP-760EF1A7", symbol: "PONSBOT", version: 4 as const, status: "active", legsJson: JSON.stringify([{ tokenId: "1324119" }, { tokenId: "1324120" }]) };

describe("liquidity NFT lookups", () => {
  it.each([
    "Show me the NFTs for position LP-760EF1A7",
    "@Ponsbotfamily show me the nfts for position 760ef1a7 please",
    "List NFTs for LP-760EF1A7", "What NFTs are in position LP-760EF1A7?",
    "Which NFTs belong to position 760ef1a7?", "NFTs for LP-760EF1A7",
  ])("parses %s read-only without AI", async text => {
    expect(isLiquidityMessage(text)).toBe(true);
    expect(await extractLiquidityFields(text, newLiquidityDraft())).toEqual({ operation: "status", fields: { position: position.publicId }, statusView: "nfts" });
    expect(openRouter).not.toHaveBeenCalled();
  });
  it.each(["Show my NFTs", "Show NFTs for position XXXXX", "Show NFTs for LQ-760EF1A7", "Show NFTs for LP-760EF1A7 and LP-1234ABCD"])("does not guess a position for %s", text => {
    expect(liquidityNftSelection(text)).toEqual({});
  });
  it.each(["send NFTs for LP-760EF1A7 to @user", "buy NFT for position LP-760EF1A7", "create a token called NFT", "What is an NFT?", "show my positions"])("does not reinterpret %s as the NFT listing", text => {
    expect(liquidityNftSelection(text)).toBeNull();
  });
  it.each([3, 4] as const)("links each ID to the V%s NFT contract, not the pool or Delta manager", version => {
    const lines = liquidityNftLines({ ...position, version });
    const contract = version === 3 ? DELTA_LIQUIDITY.v3Npm : DELTA_LIQUIDITY.v4Npm;
    for (const id of ["1324119", "1324120"]) expect(lines).toContain(`NFT #${id}: https://robinhoodchain.blockscout.com/token/${contract}/instance/${id}`);
    expect(lines.join("\n")).not.toContain(DELTA_LIQUIDITY.manager);
    expect(lines.join("\n")).toContain("position NFTs (2):\n\nNFT #1324119:");
    expect(lines.join("\n")).toContain("/instance/1324119\n\nNFT #1324120:");
  });
  it("keeps large integer IDs exact and deduplicates normalized IDs", () => {
    const lines = liquidityNftLines({ ...position, legsJson: JSON.stringify([{ tokenId: "900719925474099312345" }, { tokenId: "0900719925474099312345" }]) });
    expect(lines).toContain("Recorded Delta Liquidity position NFTs (1):");
    expect(lines.at(-1)).toContain("/instance/900719925474099312345");
  });
  it("labels closed records as historical", () => {
    expect(liquidityNftLines({ ...position, status: "closed" }).join("\n")).toContain("historical NFTs, not active liquidity");
  });
  it.each(["not json", "{}", '[{"tokenId":"../bad"}]', '[{"tokenId":"0"}]', '[{"tokenId":9007199254740993}]', JSON.stringify([{ tokenId: (1n << 256n).toString() }])])("fails safely on invalid saved legs %s", legsJson => {
    const message = liquidityNftLines({ ...position, legsJson }).join("\n");
    expect(message).toContain("couldn't read"); expect(message).not.toContain("https://");
  });
  it("handles empty records and paginates large lists without dropping links", () => {
    expect(liquidityNftLines({ ...position, legsJson: "[]" }).join("\n")).toContain("No NFT IDs");
    const ids = Array.from({ length: 100 }, (_, i) => ((1n << 255n) + BigInt(i)).toString());
    const pages = paginateLiquidityResponse(liquidityNftLines({ ...position, legsJson: JSON.stringify(ids.map(tokenId => ({ tokenId }))) }), "x", true);
    expect(pages.length).toBeGreaterThan(1);
    for (const id of ids) expect(pages.join("\n").match(new RegExp(`/instance/${id}`, "g"))).toHaveLength(1);
  });
});
