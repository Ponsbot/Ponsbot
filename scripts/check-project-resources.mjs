import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, formatEther, formatUnits, http, parseAbi } from "viem";
import { base } from "viem/chains";

const jsonMode = process.argv.includes("--json");
const timeout = (milliseconds = 20_000) => AbortSignal.timeout(milliseconds);

async function attempt(name, check) {
  try {
    return { name, ok: true, ...(await check()) };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function configured(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: init.signal || timeout() });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || (typeof body === "string" ? body.slice(0, 180) : "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return { body, headers: response.headers };
}

const checks = [];

checks.push(await attempt("CoinGecko", async () => {
  const { body } = await request("https://pro-api.coingecko.com/api/v3/key", {
    headers: { "x-cg-pro-api-key": configured("COINGECKO_PRO_API_KEY") },
  });
  return {
    source: "official",
    plan: body.plan,
    requestsPerMinute: body.api_key_rate_limit_request_per_minute ?? body.rate_limit_request_per_minute,
    monthlyLimit: body.api_key_monthly_call_credit ?? body.monthly_call_credit,
    monthlyUsed: body.api_key_current_total_monthly_calls ?? body.current_total_monthly_calls,
    monthlyRemaining: body.current_remaining_monthly_calls,
  };
}));

checks.push(await attempt("OpenRouter", async () => {
  const { body } = await request("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${configured("OPENROUTER_MANAGEMENT_API_KEY")}` },
  });
  const purchased = Number(body.data?.total_credits || 0);
  const used = Number(body.data?.total_usage || 0);
  return { source: "official", purchasedUsd: purchased, usedUsd: used, remainingUsd: purchased - used };
}));

checks.push(await attempt("Alchemy", async () => {
  const { body } = await request("https://admin-api.alchemy.com/v1/usage/summary", {
    headers: { authorization: `Bearer ${configured("ALCHEMY_ADMIN_API_ACCESS_KEY")}` },
  });
  const data = body.data || {};
  return {
    source: "official",
    billingPeriod: data.billingPeriod,
    monthToDate: data.totals?.monthToDate,
    last7Days: data.totals?.last7Days,
    last30Days: data.totals?.last30Days,
    usageLimit: data.usageLimit,
    dataThrough: data.freshness?.dataThrough,
  };
}));

checks.push(await attempt("Vercel", async () => {
  const token = configured("VERCEL_ACCESS_TOKEN");
  const teamId = configured("VERCEL_TEAM_ID");
  const headers = { authorization: `Bearer ${token}` };
  await request("https://api.vercel.com/v2/user", { headers });
  await request(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, { headers });

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const url = new URL("https://api.vercel.com/v1/billing/charges");
  url.searchParams.set("teamId", teamId);
  url.searchParams.set("from", from);
  url.searchParams.set("to", now.toISOString());
  const response = await fetch(url, { headers: { ...headers, "accept-encoding": "gzip" }, signal: timeout(30_000) });
  const text = await response.text();
  if (!response.ok) {
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    const detail = body?.error?.message || body?.message || "Billing usage unavailable";
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  const records = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const billedCost = records.reduce((sum, row) => sum + Number(row.BilledCost || 0), 0);
  const effectiveCost = records.reduce((sum, row) => sum + Number(row.EffectiveCost || 0), 0);
  return { source: "official", periodStart: from, records: records.length, billedCostUsd: billedCost, effectiveCostUsd: effectiveCost };
}));

checks.push(await attempt("Operational wallets", async () => {
  const robinhood = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const roleVariables = [
    ["admin", "AUTOMATED_FEE_ADMIN_ADDRESS"],
    ["keeper", "AUTOMATED_FEE_KEEPER_ADDRESS"],
    ["quote authorizer", "AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS"],
    ["pause guardian", "AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS"],
  ];
  const wallets = [];
  for (const [role, variable] of roleVariables) {
    const address = process.env[variable]?.trim();
    if (!address) continue;
    wallets.push({ role, address, network: "Robinhood Chain", eth: formatEther(await robinhood.getBalance({ address })) });
  }

  const cdp = new CdpClient({
    apiKeyId: configured("CDP_API_KEY_ID"),
    apiKeySecret: configured("CDP_API_KEY_SECRET"),
    walletSecret: configured("CDP_WALLET_SECRET"),
  });
  const baseClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const erc20 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
  const operationalAccounts = [
    process.env.HOUDINI_X402_CDP_ACCOUNT_NAME?.trim() || "ponsbot-houdini-x402",
    process.env.FREE_LAUNCH_SPONSOR_CDP_ACCOUNT_NAME?.trim() || "ponsbot-free-launch-sponsor",
  ];
  for (const name of operationalAccounts) {
    try {
      const account = await cdp.evm.getAccount({ name });
      const [baseEth, baseUsdc, robinhoodEth] = await Promise.all([
        baseClient.getBalance({ address: account.address }),
        baseClient.readContract({
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          abi: erc20,
          functionName: "balanceOf",
          args: [account.address],
        }),
        robinhood.getBalance({ address: account.address }),
      ]);
      wallets.push({
        role: name,
        address: account.address,
        network: "Base / Robinhood Chain",
        baseEth: formatEther(baseEth),
        baseUsdc: formatUnits(baseUsdc, 6),
        robinhoodEth: formatEther(robinhoodEth),
      });
    } catch (error) {
      wallets.push({ role: name, error: error instanceof Error ? error.message : "Lookup failed" });
    }
  }
  return { source: "onchain", wallets };
}));

const report = { checkedAt: new Date().toISOString(), readOnly: true, checks };

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Pons Bot resource check - ${report.checkedAt}`);
  for (const check of checks) {
    console.log(`\n${check.ok ? "OK" : "ATTENTION"} ${check.name}`);
    if (!check.ok) console.log(`  ${check.error}`);
    else console.log(JSON.stringify(Object.fromEntries(Object.entries(check).filter(([key]) => !["name", "ok"].includes(key))), null, 2));
  }
}

if (checks.some((check) => !check.ok)) process.exitCode = 2;
