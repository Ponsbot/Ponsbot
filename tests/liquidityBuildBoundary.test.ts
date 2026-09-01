import { describe, expect, it } from "vitest";
import ts from "typescript";
import path from "node:path";

describe("Convex liquidity build boundary", () => {
  it("does not pull the signer or Next.js market implementation into Convex's type project", () => {
    const configPath = path.resolve("convex/tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const program = ts.createProgram([path.resolve("convex/liquidity.ts")], parsed.options);
    const files = program.getSourceFiles().map(file => file.fileName.replaceAll("\\", "/"));
    expect(files.some(file => file.endsWith("/lib/liquidity-quote.ts"))).toBe(true);
    for (const forbidden of ["lib/wallet-signer/liquidity.ts", "lib/token-market-cap.ts", "lib/site-data.ts"]) {
      expect(files.filter(file => file.endsWith(`/${forbidden}`))).toEqual([]);
    }
  }, 20_000);
});
