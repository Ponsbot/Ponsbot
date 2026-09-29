import { describe, expect, it } from "vitest";
import { agentFailureCode } from "../lib/trading-agents/diagnostics";
describe("agent diagnostics", () => {
  it("preserves specific policy and worker failures through both boundaries", () => {
    for (const code of ["LIVE_BUY_LIMIT", "MODEL_LIMIT", "LIVE_HOLDINGS_INCOMPLETE", "LIVE_BALANCE_REFRESH_FAILED"]) {
      expect(agentFailureCode(new Error(agentFailureCode(new Error(code))))).toBe(code);
    }
  });
  it("never persists raw provider or model errors", () => {
    expect(agentFailureCode(new Error("https://rpc.example/secret?token=private"))).toBe("LIVE_UNCLASSIFIED_FAILURE");
    expect(agentFailureCode({ message: "MODEL_LIMIT", secret: "private" })).toBe("LIVE_UNCLASSIFIED_FAILURE");
  });
  it("classifies timeouts and invalid payloads without their contents", () => {
    for (const [name, code] of [["TimeoutError", "LIVE_REQUEST_TIMEOUT"], ["ZodError", "LIVE_PAYLOAD_INVALID"]]) {
      const error = new Error("private payload"); error.name = name;
      expect(agentFailureCode(new Error(agentFailureCode(error)))).toBe(code);
    }
  });
});
