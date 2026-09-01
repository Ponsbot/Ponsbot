import { describe, expect, it } from "vitest";
import {
  AUTOMATED_FEE_BUYBACK_BPS,
  AUTOMATED_FEE_ENGINE_INTERVAL_MS,
  automatedFeeEngineConfiguration,
  automatedFeeRunIdempotencyKey,
  splitAutomatedCreatorFees,
  validateAutomatedFeeReceipt,
  isAutomatedFeeManualTestToken,
  automatedFeeEnrollmentAllowed,
  automatedFeeDistributionEligible,
} from "../lib/automated-fee-policy";

const address = (digit: string) => `0x${digit.repeat(40)}`;

describe("automated creator fee policy", () => {
  it("exempts direct holder fee sharing from the flywheel", () => {
    expect(automatedFeeDistributionEligible("wallet")).toBe(true);
    expect(automatedFeeDistributionEligible("holders")).toBe(false);
  });
  it("is disabled and not ready by default", () => {
    expect(automatedFeeEngineConfiguration({})).toMatchObject({
      enabled: false,
      ready: false,
      capabilities: { sweepBuybackBurn: false, newLaunchEnrollment: false, existingLaunchUpgrade: false, botCommands: false },
    });
  });

  it("requires both the master switch and each independent capability switch", () => {
    const infrastructure = {
      AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: address("1"), AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS: address("2"),
      AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS: address("3"), AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS: address("8"),
      AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS: address("a"), AUTOMATED_FEE_ADMIN_ADDRESS: address("7"),
      AUTOMATED_FEE_KEEPER_ADDRESS: address("4"), AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS: address("9"),
      AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME: "ponsbot-fee-quotes", AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME: "ponsbot-fee-keeper",
      AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME: "ponsbot-fee-admin", AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS: address("5"),
      AUTOMATED_FEE_CONTROL_ADDRESS: address("6"), AUTOMATED_FEE_V3_ROUTER_ADDRESS: address("b"),
      AUTOMATED_FEE_V3_QUOTER_ADDRESS: address("c"), AUTOMATED_FEE_WETH_ADDRESS: address("d"),
    };
    const masterOff = automatedFeeEngineConfiguration({ ...infrastructure, AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED: "true" });
    expect(masterOff.capabilities.sweepBuybackBurn).toBe(false);
    const selective = automatedFeeEngineConfiguration({
      ...infrastructure, AUTOMATED_BUYBACK_BURN_ENABLED: "true", AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED: "true",
    });
    expect(selective.capabilities).toEqual({ sweepBuybackBurn: true, newLaunchEnrollment: false, existingLaunchUpgrade: false, botCommands: false });
  });

  it("fails closed when enabled without every deployed contract address", () => {
    const config = automatedFeeEngineConfiguration({ AUTOMATED_BUYBACK_BURN_ENABLED: "true" });
    expect(config.enabled).toBe(true);
    expect(config.ready).toBe(false);
    expect(config.invalid.length).toBe(16);
  });

  it("becomes ready only with every valid deployment address", () => {
    const config = automatedFeeEngineConfiguration({
      AUTOMATED_BUYBACK_BURN_ENABLED: "true",
      AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: address("1"),
      AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS: address("2"),
      AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS: address("3"),
      AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS: address("8"),
      AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS: address("a"),
      AUTOMATED_FEE_ADMIN_ADDRESS: address("7"),
      AUTOMATED_FEE_KEEPER_ADDRESS: address("4"),
      AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS: address("9"),
      AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME: "ponsbot-fee-quotes",
      AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME: "ponsbot-fee-keeper",
      AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME: "ponsbot-fee-admin",
      AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS: address("5"),
      AUTOMATED_FEE_CONTROL_ADDRESS: address("6"),
      AUTOMATED_FEE_V3_ROUTER_ADDRESS: address("b"),
      AUTOMATED_FEE_V3_QUOTER_ADDRESS: address("c"),
      AUTOMATED_FEE_WETH_ADDRESS: address("d"),
    });
    expect(config.ready).toBe(true);
    expect(config.invalid).toEqual([]);
  });

  it("rejects zero addresses and unsafe role or contract collisions", () => {
    const base = {
      AUTOMATED_BUYBACK_BURN_ENABLED: "true",
      AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: address("1"),
      AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS: address("2"),
      AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS: address("3"),
      AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS: address("8"),
      AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS: address("a"),
      AUTOMATED_FEE_ADMIN_ADDRESS: address("4"),
      AUTOMATED_FEE_KEEPER_ADDRESS: address("5"),
      AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS: address("9"),
      AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME: "ponsbot-fee-quotes",
      AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME: "ponsbot-fee-keeper",
      AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME: "ponsbot-fee-admin",
      AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS: address("6"),
      AUTOMATED_FEE_CONTROL_ADDRESS: address("7"),
      AUTOMATED_FEE_V3_ROUTER_ADDRESS: address("b"),
      AUTOMATED_FEE_V3_QUOTER_ADDRESS: address("c"),
      AUTOMATED_FEE_WETH_ADDRESS: address("d"),
    };
    expect(automatedFeeEngineConfiguration({ ...base, AUTOMATED_FEE_KEEPER_ADDRESS: `0x${"0".repeat(40)}` }).ready).toBe(false);
    expect(automatedFeeEngineConfiguration({ ...base, AUTOMATED_FEE_KEEPER_ADDRESS: address("4") }).invalid).toContain("roleAddressCollision");
    expect(automatedFeeEngineConfiguration({ ...base, AUTOMATED_FEE_CONTROL_ADDRESS: address("1") }).invalid).toContain("contractAddressCollision");
  });

  it("allocates exactly five percent with all rounding left to the beneficiary", () => {
    expect(AUTOMATED_FEE_BUYBACK_BPS).toBe(500);
    expect(splitAutomatedCreatorFees(101n)).toEqual({ gross: 101n, buyback: 5n, beneficiary: 96n });
    expect(splitAutomatedCreatorFees(10_000n)).toEqual({ gross: 10_000n, buyback: 500n, beneficiary: 9_500n });
  });

  it("uses a fifteen minute schedule and stable per-block idempotency", () => {
    expect(AUTOMATED_FEE_ENGINE_INTERVAL_MS).toBe(900_000);
    expect(automatedFeeRunIdempotencyKey(address("a"), "123")).toBe(`automated-fees:${address("a")}:123`);
  });

  it("rejects inconsistent confirmed receipt accounting", () => {
    expect(validateAutomatedFeeReceipt({
      grossClaimed: "10000",
      beneficiaryAllocated: "9500",
      buybackSpent: "500",
      ponsbotBurned: "123",
    })).toMatchObject({ gross: 10_000n, allocation: 9_500n, buyback: 500n, burned: 123n });
    expect(() => validateAutomatedFeeReceipt({
      grossClaimed: "10000",
      beneficiaryAllocated: "9600",
      buybackSpent: "400",
      ponsbotBurned: "123",
    })).toThrow(/accounting invariant/);
    expect(() => validateAutomatedFeeReceipt({
      grossClaimed: "10000",
      beneficiaryAllocated: "9500",
      buybackSpent: "500",
      ponsbotBurned: "0",
    })).toThrow(/burn invariant/);
    expect(() => validateAutomatedFeeReceipt({
      grossClaimed: "0",
      beneficiaryAllocated: "0",
      buybackSpent: "0",
      ponsbotBurned: "0",
    })).toThrow(/gross amount is zero/);
    expect(() => validateAutomatedFeeReceipt({
      grossClaimed: "19",
      beneficiaryAllocated: "19",
      buybackSpent: "0",
      ponsbotBurned: "1",
    })).toThrow(/zero-buyback burn invariant/);
  });

  it("requires an explicit valid existing-token allowlist for private test mode", () => {
    const token = address("a");
    const config = automatedFeeEngineConfiguration({
      AUTOMATED_BUYBACK_BURN_ENABLED: "false",
      AUTOMATED_FEE_MANUAL_TEST_ENABLED: "true",
      AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES: token,
      AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: address("1"),
      AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS: address("2"),
      AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS: address("3"),
      AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS: address("8"),
      AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS: address("c"),
      AUTOMATED_FEE_ADMIN_ADDRESS: address("7"),
      AUTOMATED_FEE_KEEPER_ADDRESS: address("4"),
      AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS: address("9"),
      AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME: "ponsbot-fee-quotes",
      AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME: "ponsbot-fee-keeper",
      AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME: "ponsbot-fee-admin",
      AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS: address("5"),
      AUTOMATED_FEE_CONTROL_ADDRESS: address("6"),
      AUTOMATED_FEE_V3_ROUTER_ADDRESS: address("b"),
      AUTOMATED_FEE_V3_QUOTER_ADDRESS: address("d"),
      AUTOMATED_FEE_WETH_ADDRESS: address("e"),
    });
    expect(config.ready).toBe(false);
    expect(config.manualTestReady).toBe(true);
    expect(isAutomatedFeeManualTestToken(token.toUpperCase().replace("0X", "0x"), config.manualTestTokens)).toBe(true);
    expect(isAutomatedFeeManualTestToken(address("b"), config.manualTestTokens)).toBe(false);
    expect(automatedFeeEnrollmentAllowed(config, token, "upgrade", false, true)).toBe(true);
    expect(automatedFeeEnrollmentAllowed(config, token, "new_launch", false, true)).toBe(false);
    expect(automatedFeeEnrollmentAllowed(config, address("b"), "upgrade", false, true)).toBe(false);
  });
});
