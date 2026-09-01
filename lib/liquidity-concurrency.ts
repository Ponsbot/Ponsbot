export async function mapLiquidityBounded<T, R>(values: T[], callback: (value: T) => Promise<R>, width = 3): Promise<R[]> {
  const output: R[] = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (cursor < values.length) { const i = cursor++; output[i] = await callback(values[i]); }
  }));
  return output;
}
