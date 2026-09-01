import { CdpClient } from "@coinbase/cdp-sdk";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

const accountNames = [
  ["launcher", "ponsbot-fee-test-launcher"],
  ["admin", process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-admin"],
  ["keeper", process.env.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-keeper"],
  ["quoteAuthorizer", process.env.AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME?.trim() || "ponsbot-automated-fee-quotes"],
  ["pauseGuardian", "ponsbot-automated-fee-guardian"],
];

for (const [, name] of accountNames) {
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(name)) throw new Error(`Invalid CDP account name: ${name}`);
}

const client = new CdpClient({
  apiKeyId: required("CDP_API_KEY_ID"),
  apiKeySecret: required("CDP_API_KEY_SECRET"),
  walletSecret: required("CDP_WALLET_SECRET"),
});

const accounts = {};
for (const [role, name] of accountNames) {
  const account = await client.evm.getOrCreateAccount({ name });
  accounts[role] = { name, address: account.address };
}

console.log(JSON.stringify({ accounts }, null, 2));
console.log("No wallets were funded and no blockchain transactions were submitted.");
