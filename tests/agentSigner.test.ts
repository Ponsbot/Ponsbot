import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { provision, chain, multicall, markets } = vi.hoisted(() => ({ provision: vi.fn(), chain: vi.fn(), multicall: vi.fn(), markets: vi.fn() }));
vi.mock("../lib/wallet-signer/service", () => ({ provisionWallet: provision }));
vi.mock("../lib/gecko-token-market", () => ({ geckoTokenMarkets: markets }));
vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: async () => 2000 }));
vi.mock("../lib/rpc-http", () => ({ resilientRobinhoodHttp: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: chain, getGasPrice: async () => 1000n, multicall, getBalance: async () => 10n }) }));
import { agentMarketSnapshot, provisionAgentWallet } from "../lib/wallet-signer/agents";

beforeEach(() => {
  provision.mockReset(); chain.mockReset().mockResolvedValue(4663); multicall.mockReset(); markets.mockReset().mockResolvedValue(new Map());
  vi.stubEnv("TRADING_AGENTS_ENABLED", "true"); vi.stubEnv("TRADING_AGENTS_WALLETS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());
describe("agent signer boundary", () => {
  it("uses a separate namespace, never an X wallet", async () => {
    provision.mockResolvedValue({ address: `0x${"1".repeat(40)}` });
    await provisionAgentWallet({ agentId: "agent123456" });
    expect(provision).toHaveBeenCalledWith("agent:agent123456");
  });
  it.each([{ agentId: "x:12345678" }, { agentId: "agent123456", ownerReference: "x:123" }])("rejects identity overrides", async input => {
    await expect(provisionAgentWallet(input)).rejects.toThrow(); expect(provision).not.toHaveBeenCalled();
  });
  it("does not provision with the feature off", async () => {
    vi.stubEnv("TRADING_AGENTS_ENABLED", "false");
    await expect(provisionAgentWallet({ agentId: "agent123456" })).rejects.toThrow("DISABLED"); expect(provision).not.toHaveBeenCalled();
  });
  it("rejects the wrong chain before requesting market data", async () => {
    chain.mockResolvedValue(1);
    await expect(agentMarketSnapshot({ tokens: [] })).rejects.toThrow("WRONG_CHAIN"); expect(markets).not.toHaveBeenCalled();
  });
  it("does not invent prices when Gecko has no data", async () => {
    multicall.mockResolvedValue([{ status: "success", result: "TEST" }, { status: "success", result: 6 }]);
    const result = await agentMarketSnapshot({ tokens: [`0x${"1".repeat(40)}`] });
    expect(result.tokens[0]).toEqual({ address: `0x${"1".repeat(40)}`, symbol: "TEST", decimals: 6 });
  });
});
