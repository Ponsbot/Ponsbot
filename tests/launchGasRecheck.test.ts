import { expect, it, vi } from "vitest";
import { recheckLaunchGas } from "../lib/wallet-signer/gas";

const quote = (gas: bigint) => ({ estimatedGas: gas, fees: { maxFeePerGas: 1_000_000_000n } });
it("does not recheck ordinary transactions or inexpensive launches", async () => {
  const refresh = vi.fn();
  await recheckLaunchGas(quote(3_000_000n), undefined, refresh);
  await recheckLaunchGas(quote(1_000_000n), 500_000_000_000_000n, refresh);
  expect(refresh).not.toHaveBeenCalled();
});
it.each([1_000_000n, 4_000_000n])("uses the second quote whether lower or higher: %s", async gas => {
  const next = quote(gas), refresh = vi.fn().mockResolvedValue(next);
  expect(await recheckLaunchGas(quote(2_000_000n), 500_000_000_000_000n, refresh)).toBe(next);
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("does not silently use stale pricing if the recheck fails", async () => {
  await expect(recheckLaunchGas(quote(2_000_000n), 500_000_000_000_000n, async () => { throw new Error("RPC unavailable"); })).rejects.toThrow("RPC unavailable");
});
