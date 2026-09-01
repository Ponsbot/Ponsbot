import { CdpX402Client } from "@coinbase/cdp-sdk/x402";

// Node 22 can load the same local file Next.js uses without adding a runtime
// dotenv dependency. Existing shell variables retain precedence.
try { process.loadEnvFile?.(".env.local"); } catch {}

for (const key of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
const accountName = process.env.HOUDINI_X402_CDP_ACCOUNT_NAME || "ponsbot-houdini-x402";
const client = new CdpX402Client({
  walletConfig: { type: "eoa", accountName },
  environment: "production",
  spendControls: {
    maxAmountPerPayment: { atomic: 10_000n, asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    allowedNetworks: ["eip155:8453"],
    allowedAssets: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  },
});
const { evmAddress } = await client.getAddresses();
console.log(`Houdini x402 CDP account: ${accountName}`);
console.log(`Fund this Base address with native USDC: ${evmAddress}`);
