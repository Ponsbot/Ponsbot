export async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency limit must be positive");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
}

export function perTokenScanRange(cursors: Array<string | undefined>, initialBlock: bigint, latest: bigint, chunkSize = 5_000n) {
  const from = cursors.reduce<bigint>((earliest, cursor) => {
    const next = cursor ? BigInt(cursor) + 1n : initialBlock;
    return next < earliest ? next : earliest;
  }, latest);
  const to = from + chunkSize - 1n < latest ? from + chunkSize - 1n : latest;
  return { from, to };
}

export function nextTokenCursor(prior: string | undefined, scannedThrough: bigint) {
  const current = prior ? BigInt(prior) : 0n;
  return (current > scannedThrough ? current : scannedThrough).toString();
}

export function transferAttributedWallet(kind: "buy" | "sell", transfers: Array<{ from: string; to: string }>, infrastructure: Set<string>, fallback: string) {
  const candidates = transfers.map((transfer) => kind === "buy" ? transfer.to : transfer.from)
    .filter((address) => !infrastructure.has(address.toLowerCase()) && !/^0x0{40}$/i.test(address));
  const unique = [...new Set(candidates.map((address) => address.toLowerCase()))];
  return unique.length === 1 ? unique[0] : fallback;
}
