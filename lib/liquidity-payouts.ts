/** Explorer fallback remains transaction-scoped and requires complete paging. */
export async function explorerLiquidityNativePayout(hash: string, owner: string): Promise<bigint | undefined> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash) || !/^0x[a-fA-F0-9]{40}$/.test(owner)) return undefined;
  let params = new URLSearchParams(), total = 0n;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < 4; page++) {
      const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/transactions/${hash}/internal-transactions?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return undefined;
      const data = await response.json() as { items: Array<{ index: number; success: boolean; error?: string; type: string; value: string; from: { hash: string }; to?: { hash: string }; transaction_hash?: string }>; next_page_params?: Record<string, string | number> | null };
      if (!Array.isArray(data.items) || !data.items.length && page === 0) return undefined;
      for (const item of data.items) {
        if (item.transaction_hash && item.transaction_hash.toLowerCase() !== hash.toLowerCase()) return undefined;
        if (typeof item.success !== "boolean" || !Number.isInteger(item.index) || !/^\d+$/.test(item.value)) return undefined;
        if (!item.success || item.error || !["call", "selfdestruct"].includes(item.type.toLowerCase())) continue;
        const key = String(item.index); if (seen.has(key)) return undefined; seen.add(key);
        total += (item.to?.hash.toLowerCase() === owner.toLowerCase() ? BigInt(item.value) : 0n) - (item.from?.hash.toLowerCase() === owner.toLowerCase() ? BigInt(item.value) : 0n);
      }
      if (!data.next_page_params) return total;
      params = new URLSearchParams(Object.entries(data.next_page_params).map(([key, value]) => [key, String(value)]));
    }
  } catch { /* Missing, partial, or delayed data must not be reported as zero. */ }
  return undefined;
}
