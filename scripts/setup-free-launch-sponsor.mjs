import { CdpClient } from "@coinbase/cdp-sdk";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

const name = required("FREE_LAUNCH_SPONSOR_CDP_ACCOUNT_NAME");
if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) throw new Error("FREE_LAUNCH_SPONSOR_CDP_ACCOUNT_NAME is invalid");

const client = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});
const account = await client.evm.getOrCreateAccount({ name });

console.log(`Free-launch sponsor CDP account: ${name}`);
console.log(`Robinhood Chain address: ${account.address}`);
console.log("Fund this address with Robinhood Chain ETH before enabling the campaign.");
