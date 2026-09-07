import { describe, expect, it } from "vitest";
import { historicalAssetCandle } from "../lib/historical-asset-fee-prices";
const address = "0x1111111111111111111111111111111111111111";
const bucket = 1700000100000;
describe("historical asset fee prices", () => {
  const body = () => ({ meta: { base: { address } }, data: { attributes: { ohlcv_list: [[bucket / 1000, 2.5, 3, 2, 2.8, 100]] } } });
  it("uses an exact historical opening price", () => expect(historicalAssetCandle(body(), address, bucket)).toBe(2.5));
  it("rejects a different token, absent bucket and future candle", () => {
    expect(historicalAssetCandle(body(), address.replaceAll("1", "2"), bucket)).toBeUndefined();
    expect(historicalAssetCandle(body(), address, bucket - 300000)).toBeUndefined();
    expect(historicalAssetCandle(body(), address, Date.now() + 300000)).toBeUndefined();
  });
});
