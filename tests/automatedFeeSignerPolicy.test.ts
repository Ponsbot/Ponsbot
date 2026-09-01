import { describe, expect, it } from "vitest";
import { automatedFeeClaimableRequestSchema, automatedFeeEnrollmentVerificationRequestSchema, automatedFeeInspectionRequestSchema, automatedFeeVaultDeploymentStatusRequestSchema, automatedFeeVaultPredictionRequestSchema } from "../lib/wallet-signer/policy";

describe("automated fee signer inspection policy", () => {
  it("accepts only a Robinhood Chain vault inspection", () => {
    const vaultAddress = `0x${"a".repeat(40)}`;
    expect(automatedFeeInspectionRequestSchema.parse({ chainId: 4663, vaultAddress })).toEqual({
      chainId: 4663,
      vaultAddress,
    });
  });

  it("rejects an invalid chain, address, or extra request fields", () => {
    const vaultAddress = `0x${"a".repeat(40)}`;
    expect(() => automatedFeeInspectionRequestSchema.parse({ chainId: 1, vaultAddress })).toThrow();
    expect(() => automatedFeeInspectionRequestSchema.parse({ chainId: 4663, vaultAddress: "0x1234" })).toThrow();
    expect(() => automatedFeeInspectionRequestSchema.parse({ chainId: 4663, vaultAddress, token: vaultAddress })).toThrow();
  });

  it("binds former-beneficiary delivery reads to one vault, beneficiary, and asset", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const request = { chainId: 4663, vaultAddress: address("1"), beneficiary: address("2"), asset: address("0") };
    expect(automatedFeeClaimableRequestSchema.parse(request)).toEqual(request);
    expect(() => automatedFeeClaimableRequestSchema.parse({ ...request, chainId: 1 })).toThrow();
    expect(() => automatedFeeClaimableRequestSchema.parse({ ...request, amount: "1" })).toThrow();
  });

  it("binds enrollment verification to both receipts and the complete expected vault state", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const hash = `0x${"a".repeat(64)}`;
    const request = {
      chainId: 4663, vaultAddress: address("1"), tokenAddress: address("2"), controllerAddress: address("3"),
      beneficiaryAddress: address("4"), pairTokenAddress: address("0"), deploymentTransactionHash: hash,
      enrollmentTransactionHash: hash, enrollmentSource: "upgrade" as const,
    };
    expect(automatedFeeEnrollmentVerificationRequestSchema.parse(request).tokenAddress).toBe(address("2"));
    expect(() => automatedFeeEnrollmentVerificationRequestSchema.parse({ ...request, enrollmentTransactionHash: "0x1234" })).toThrow();
    expect(() => automatedFeeEnrollmentVerificationRequestSchema.parse({ ...request, enrollmentSource: "manual" })).toThrow();
    expect(() => automatedFeeEnrollmentVerificationRequestSchema.parse({ ...request, extra: true })).toThrow();
  });

  it("strictly binds pre-launch vault prediction to a token, factory stack, salt, and enrollment source", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const request = {
      chainId: 4663, tokenAddress: address("1"), vaultFactoryAddress: address("2"),
      ponsFactoryAddress: address("3"), salt: `0x${"a".repeat(64)}`, enrollmentSource: "new_launch" as const,
    };
    expect(automatedFeeVaultPredictionRequestSchema.parse(request)).toEqual(request);
    expect(() => automatedFeeVaultPredictionRequestSchema.parse({ ...request, salt: "0x1234" })).toThrow();
    expect(() => automatedFeeVaultPredictionRequestSchema.parse({ ...request, enrollmentSource: "manual" })).toThrow();
    expect(() => automatedFeeVaultPredictionRequestSchema.parse({ ...request, unexpected: true })).toThrow();
  });

  it("requires enough transaction identity to safely recover a vault deployment", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const request = {
      chainId: 4663, tokenAddress: address("1"), vaultFactoryAddress: address("2"), vaultAddress: address("3"),
      transactionHash: `0x${"b".repeat(64)}`, transactionNonce: 7, broadcastAt: Date.now(), enrollmentSource: "upgrade" as const,
    };
    expect(automatedFeeVaultDeploymentStatusRequestSchema.parse(request).transactionNonce).toBe(7);
    expect(() => automatedFeeVaultDeploymentStatusRequestSchema.parse({ ...request, transactionNonce: -1 })).toThrow();
    expect(() => automatedFeeVaultDeploymentStatusRequestSchema.parse({ ...request, transactionHash: "0x1234" })).toThrow();
  });
});
