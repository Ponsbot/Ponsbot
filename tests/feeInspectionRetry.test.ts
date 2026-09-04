import { describe, expect, it, vi } from "vitest";
import { retryFeeInspection } from "../lib/fee-inspection-retry";
describe("fee inspection snapshots", () => {
  it("restarts the whole snapshot and permits public-provider fallback", async () => {
    const inspect = vi.fn().mockRejectedValueOnce(new Error("header not found"))
      .mockRejectedValueOnce(new Error("Details: header not ")).mockResolvedValueOnce({ block: 123, beneficiary: "new" });
    const pause = vi.fn().mockResolvedValue(undefined);
    expect(await retryFeeInspection(inspect, pause)).toEqual({ block: 123, beneficiary: "new" });
    expect(inspect.mock.calls).toEqual([[0], [1], [2]]);
    expect(pause.mock.calls).toEqual([[750], [1500]]);
  });
  it("bounds retry attempts", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("unknown block"));
    await expect(retryFeeInspection(inspect, async () => {})).rejects.toThrow("unknown block");
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  it.each(["controller mismatch", "execution reverted", "invalid signature", "RPC chain mismatch"])("does not retry %s", async message => {
    const inspect = vi.fn().mockRejectedValue(new Error(message));
    await expect(retryFeeInspection(inspect, async () => {})).rejects.toThrow(message);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
