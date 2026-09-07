import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { environment: "node", maxWorkers: 4, testTimeout: 20_000, hookTimeout: 20_000, exclude: [...configDefaults.exclude, "**/.deployment-private/**"] },
});
