import { createHmac } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http } from "viem";

for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "WALLET_SIGNER_IDEMPOTENCY_SECRET"]) {
  if (!process.env[name]) throw new Error(`${name} is missing`);
}
const ownerReference = "x:999999999999999999999999999999";
const digest = createHmac("sha256", process.env.WALLET_SIGNER_IDEMPOTENCY_SECRET)
  .update(`ponsbot:robinhood:4663:${ownerReference}`).digest("hex");
const name = `ponsbot-rh-${digest.slice(0, 25)}`;
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});
const first = await cdp.evm.getOrCreateAccount({ name });
const second = await cdp.evm.getOrCreateAccount({ name });
if (first.address.toLowerCase() !== second.address.toLowerCase()) throw new Error("CDP wallet provisioning is not idempotent");
const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com") });
if (await client.getChainId() !== 4663) throw new Error("Robinhood RPC chain mismatch");
await client.getBalance({ address: first.address });
console.log(JSON.stringify({ ok: true, address: first.address, chainId: 4663 }));
