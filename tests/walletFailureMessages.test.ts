import { describe, expect, it } from "vitest";
import { safeFailure } from "../convex/wallets";

describe("wallet failure messages", () => {
  it("explains when a launch wallet cannot cover value and gas", () => {
    expect(safeFailure(new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.")))
      .toBe("⛽ You'll need to fund your wallet with ETH for gas to complete this transaction. Fund it, then reply “resume”.");
  });

  it("does not describe a failed buy as a launch", () => {
    expect(safeFailure(new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."), "buy"))
      .toBe("⛽ You'll need to fund your wallet with ETH for gas to buy. Fund it, then reply “resume”.");
  });

  it("maps the signer's pre-sign maximum-cost check to the launch gas response", () => {
    expect(safeFailure(new Error("transaction total cost (gas * gas fee + value) exceeds the balance"), "launch"))
      .toBe("⛽ You'll need to fund your wallet with ~0.0015 ETH for gas and the Pons launch fee. Fund it, then reply “resume”.");
  });

  it("explains when an earlier wallet operation still holds the execution lease", () => {
    expect(safeFailure(new Error("another wallet transaction is still being prepared; please try again shortly")))
      .toBe("⏳ Your wallet is still processing an earlier transaction. Wait for it to finish, then reply with the launch request again!");
  });
});
