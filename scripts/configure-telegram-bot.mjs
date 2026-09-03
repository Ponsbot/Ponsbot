const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
const dropPendingUpdates = process.argv.includes("--drop-pending-updates");
const checkOnly = process.argv.includes("--check");
if (!token || !secret || !site) throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and NEXT_PUBLIC_SITE_URL are required");
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 URL-safe characters");

async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${method}: ${result.description || response.status}`);
  return result.result;
}

const commands = [
  { command: "start", description: "Open the Pons Bot menu" },
  { command: "wallet", description: "Show or create your Pons Bot wallet" },
  { command: "balance", description: "Show wallet balances" },
  { command: "buy", description: "Buy a Robinhood Chain token" },
  { command: "sell", description: "Sell a Robinhood Chain token" },
  { command: "swap", description: "Swap one token for another" },
  { command: "send", description: "Send tokens or ETH" },
  { command: "burn", description: "Burn tokens" },
  { command: "fees", description: "Claim creator or LP fees" },
  { command: "liquidity", description: "Create or manage liquidity positions" },
  { command: "positions", description: "Show your liquidity positions" },
  { command: "crosschain", description: "Start a cross-chain swap" },
  { command: "private", description: "Start a private swap" },
  { command: "help", description: "See everything Pons Bot can do" },
  { command: "cancel", description: "Cancel the active guided workflow" },
  { command: "link", description: "Connect your X account" },
];

if (checkOnly) {
  const [bot, webhook] = await Promise.all([call("getMe", {}), call("getWebhookInfo", {})]);
  console.log(JSON.stringify({
    status: "checked",
    botUsername: bot.username,
    expectedWebhook: `${site}/api/telegram/webhook`,
    configuredWebhook: webhook.url || null,
    webhookMatches: webhook.url === `${site}/api/telegram/webhook`,
    pendingUpdates: webhook.pending_update_count,
    lastErrorDate: webhook.last_error_date || null,
    lastErrorMessage: webhook.last_error_message || null,
  }, null, 2));
  process.exit(0);
}

await call("setMyCommands", { commands });
await call("setChatMenuButton", { menu_button: { type: "commands" } });
await call("setWebhook", {
  url: `${site}/api/telegram/webhook`, secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  // Dropping updates is destructive and is therefore opt-in for an intentional
  // first activation or emergency reset. Routine reconfiguration preserves
  // messages Telegram has already accepted for delivery.
  drop_pending_updates: dropPendingUpdates,
});
const info = await call("getWebhookInfo", {});
console.log(JSON.stringify({
  status: "configured",
  webhook: info.url,
  pendingUpdates: info.pending_update_count,
  pendingUpdatesDropped: dropPendingUpdates,
  commands: commands.length,
}, null, 2));
