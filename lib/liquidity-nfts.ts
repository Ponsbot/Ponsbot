import { DELTA_LIQUIDITY } from "./liquidity-workflow";

/** Recorded NFT IDs only, not a claim about their current on-chain ownership. */
export function liquidityNftLines(position: { publicId: string; symbol: string; version: 3 | 4; status: string; legsJson: string }): string[] {
  const title = `💧 ${position.publicId} • $${position.symbol}`;
  try {
    const legs: unknown = JSON.parse(position.legsJson);
    if (!Array.isArray(legs) || legs.length > 100) throw new Error("Invalid NFT records");
    const ids = [...new Set(legs.map(leg => {
      if (!leg || typeof leg.tokenId !== "string" || !/^\d{1,78}$/.test(leg.tokenId)) throw new Error("Invalid NFT ID");
      const id = BigInt(leg.tokenId);
      if (id <= 0n || id >= 1n << 256n) throw new Error("Invalid NFT ID");
      return id.toString();
    }))];
    if (!ids.length) return [title, "", "No NFT IDs are recorded for this position yet."];
    const contract = position.version === 3 ? DELTA_LIQUIDITY.v3Npm : position.version === 4 ? DELTA_LIQUIDITY.v4Npm : undefined;
    if (!contract) throw new Error("Unknown NFT contract");
    return [title, "", `Recorded Delta Liquidity position NFTs (${ids.length}):`,
      ...(position.status === "closed" ? ["", "This position is closed. These links show its historical NFTs, not active liquidity."] : []),
      "", ...ids.flatMap((id, index) => [...(index ? [""] : []), `NFT #${id}: https://robinhoodchain.blockscout.com/token/${contract}/instance/${id}`])];
  } catch { return [title, "", "I couldn't read this position's NFT records. Reply with the request again later."]; }
}
