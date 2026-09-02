import { xWeightedLength } from "../convex/xText";
import type { LiquidityDraft } from "./liquidity-workflow";
import { formatLiquidityMarketCap } from "./liquidity-market-cap";
import { liquidityHigherRisk } from "./liquidity-analysis-policy";

export const LIQUIDITY_REASONS = {
  active_trading: "🟢 Trading is active in the latest hour",
  strong_recent_volume: "🟢 Strong recent trading volume",
  sustained_activity: "🟢 Trading has remained active across the 1h, 6h, and 24h windows",
  low_trader_cost: "🟢 Lower swap fee may help attract trades",
  higher_lp_fee: "🟢 Higher LP fee earned on each trade",
  established_pool: "🟢 Substantial existing pool liquidity",
  thin_depth: "🔴 Very little liquidity is active near the current price",
  high_trader_fee: "🟡 Higher swap fee may discourage some trades",
  very_high_trader_fee: "🔴 Very high swap fee may strongly discourage trading",
  quiet_recently: "🟡 No trading activity in the latest hour",
  recent_slowdown: "🟡 Recent trading is below the pool’s longer-term pace",
  short_term_spike: "🟡 Recent volume may be concentrated in a short-term spike",
  limited_history: "🟡 Limited fresh market history",
  new_market: "🟡 No established trading history",
  fee_paying: "🟢 Trades in this pool pay LP fees",
  range_risk: "🟡 Range-dependent liquidity",
} as const;
export const LIQUIDITY_RESPONSES = {
  stale: "⌛ This reply is attached to an older liquidity step. Reply to the latest Pons Bot liquidity message so I use your current saved setup.",
  busy: "⏳ I’m still preparing your liquidity request.",
  expired: "⌛ This setup expired. Reply with a complete new liquidity request to start again.",
  cancelled: "Liquidity setup cancelled. No funds were moved.",
  next: "➡️ Reply next to see the remaining details.",
  failed: "⚠️ I couldn’t complete that step. Your choices are saved. Reply refresh to retry, or cancel.",
  unresolved: "🔎 I couldn’t identify one matching token. Reply with its contract address.",
  position: "🔎 Which position? Provide its ID, with or without LP-. Say show my liquidity positions to see your list.",
  notOwner: "⚠️ That position doesn’t belong to your wallet.",
  help: "💧 Create a liquidity position with Delta Liquidity to earn a share of trading fees. I’ll compare pools and guide you through the settings, then give you a quote to confirm.\n\nCheck your positions, collect LP fees, or withdraw by position ID.\n\nAsk “what does this mean?” at any step for help.\n\nAsk me to \"create a $100 liquidity position for $PONSBOT\" to get started.",
  noPositions: "💧 No matching active liquidity positions found for your wallet.",
  blocked: "🛠️ Partial withdrawals and automatic compounding aren’t available yet. You can collect fees or withdraw fully.",
  addUnavailable: "🛠️ Adding to a position isn’t available yet. Create a new one with the same settings and a new budget? Reply yes to create the new position.",
  partialUnavailable: "🛠️ Partial withdrawals aren’t available yet. Say yes to withdraw the whole position and collect its fees instead.",
  foreignThread: "💧 Please start a new post for your own Delta Liquidity position. Ask me to \"create liquidity for $PONSBOT\".",
  claimTarget: "💰 Which LP fees should I collect? Provide a position ID, token, or say all.",
  claimTooMany: "⚠️ Up to 20 positions can be claimed at once. Choose a token or position ID.",
  ambiguousClaim: "🔎 More than one token uses that ticker. Reply with the contract address or a position ID.",
  invalid: "⚠️ Those settings don’t fit together. Please update your choice.",
  funding: "⚠️ You don’t have enough assets for this position and gas.",
  fundingGas: "⚠️ You don’t have enough ETH for this position and gas.",
  noSelection: "🔢 Choose a number from the pool list, or say custom pool.",
  waiting: "💧 You already have a setup in progress. Respond continue to continue, or reply cancel before starting another.",
  settingsConflict: "⚠️ Those settings differ from the existing position. Create a separate position to use them.",
  capacity: "⚠️ This position has reached its band limit. Create a separate position for more liquidity.",
} as const;
export function liquidityFundingMessage(d: Pick<LiquidityDraft, "symbol" | "fields">, walletAddress: string | undefined, gasOnly = false) {
  const symbol = d.symbol || d.fields.token?.replace(/^\$/, "").toUpperCase();
  const assets = [...new Set(["ETH", "USDG", ...(symbol && !["ETH", "USDG"].includes(symbol) ? [`$${symbol}`] : [])])];
  const list = assets.length > 1 ? `${assets.slice(0, -1).join(", ")}, or ${assets.at(-1)}` : assets[0];
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.ponsbot.family").replace(/\/$/, "");
  const wallet = walletAddress ? `${site}/wallet/${walletAddress}` : undefined;
  return [
    gasOnly ? LIQUIDITY_RESPONSES.fundingGas : `⚠️ You don’t have enough ${list} for this position and gas.`,
    "Add ETH to your Pons Bot wallet, then reply resume. Pons Bot will buy any other assets the position needs.",
    ...(wallet ? ["", `Your wallet: ${wallet}`] : []),
  ].join("\n");
}
function liquiditySections(...sections: Array<Array<string | undefined>>): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    const present = section.filter((line): line is string => Boolean(line));
    if (!present.length) continue;
    if (lines.length) lines.push("");
    lines.push(...present);
  }
  return lines;
}
export function liquidityCompact(value: number) {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}m`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}
function liquidityComparisonIncomplete(d: LiquidityDraft) {
  const displayedMetricsComplete = d.candidates.length > 0 && d.candidates.every(candidate =>
    [candidate.activeDepthUsd, candidate.reserveUsd, candidate.volumeHourUsd, candidate.volumeDayUsd]
      .every(value => typeof value === "number" && Number.isFinite(value)));
  if (displayedMetricsComplete) return false;
  return d.analysis?.diagnostics.some(code => [
    "GECKO_BUDGET_DEFERRED", "GECKO_STALE_OR_INVALID", "GECKO_UNAVAILABLE",
    "DESCRIPTOR_LOOKUP_FAILED", "SOME_POOL_READS_FAILED", "ANALYSIS_TIME_BUDGET",
  ].includes(code) || /^GECKO_HTTP_/.test(code)) ?? false;
}
function liquidityPoolNotices(d: LiquidityDraft) {
  return [
    ...(d.analysis?.stage === "low" || d.analysis?.stage === "limited" ? ["🟡 Few active pools matched, so quieter options are included."] : []),
    ...(liquidityComparisonIncomplete(d) ? ["🟡 Some data is unavailable. This comparison may be incomplete."] : []),
    ...(d.candidates.every(p => p.volumeHourUsd == null && p.volumeDayUsd == null) ? ["🟡 Volume couldn't be determined, so these options are unranked."] : []),
  ];
}
function liquidityQuoteAmount(raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0) return raw;
  if (Math.abs(value) >= 1e21) return value.toPrecision(5).replace(/\.0+(?=e)/, "").replace(/(\.\d*?)0+(?=e)/, "$1");
  return value.toLocaleString("en-US", { maximumSignificantDigits: 5, useGrouping: true });
}
function liquidityQuoteUsd(raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return `$${raw}`;
  if (value === 0) return "$0";
  const maximumFractionDigits = Math.abs(value) >= 1 ? 2
    : Math.min(8, Math.max(2, -Math.floor(Math.log10(Math.abs(value))) + 3));
  return `$${value.toLocaleString("en-US", { maximumFractionDigits })}`;
}
function liquidityQuoteUsdRates(lines: string[]) {
  const rates = new Map<string, number>();
  for (const line of lines) {
    const valued = /^Maximum ([^:]+): (\d+(?:\.\d+)?) \(\$(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\)\.$/i.exec(line);
    if (valued) {
      const amount = Number(valued[2]), usd = Number(valued[3]);
      if (amount > 0 && Number.isFinite(usd)) rates.set(valued[1].toUpperCase(), usd / amount);
    }
    if (/^Maximum USDG: \$\d/i.test(line)) rates.set("USDG", 1);
  }
  return rates;
}
function liquidityQuoteAssetUsd(amount: string, symbol: string, rates: Map<string, number>) {
  const rate = rates.get(symbol.toUpperCase());
  return rate !== undefined ? ` (${liquidityQuoteUsd(String(Number(amount) * rate))})` : "";
}
function readableQuoteAmounts(line: string, rates: Map<string, number>) {
  return line
    .replace(/^(Maximum USDG: )\$(\d+(?:\.\d+)?)(\.)$/, (_all, prefix: string, amount: string, suffix: string) => `${prefix}${liquidityQuoteUsd(amount)}${suffix}`)
    .replace(/^(Maximum [^:]+: )(\d+(?:\.\d+)?) \(\$(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\)(\.)$/i,
      (_all, prefix: string, amount: string, usd: string, suffix: string) => `${prefix}${liquidityQuoteAmount(amount)} (${liquidityQuoteUsd(usd)})${suffix}`)
    .replace(/^(Maximum [^:]+: )(\d+(?:\.\d+)?)(\.)$/, (_all, prefix: string, amount: string, suffix: string) => `${prefix}${liquidityQuoteAmount(amount)}${suffix}`)
    .replace(/^((?:Buy missing|Wrap ETH for) )(\d+(?:\.\d+)?) ([^:]+): (\d+(?:\.\d+)?) ETH maximum\.$/,
      (_all, action: string, amount: string, symbol: string, eth: string) => {
        const displayed = symbol.toUpperCase() === "USDG"
          ? liquidityQuoteUsd(amount)
          : `${liquidityQuoteAmount(amount)} ${symbol}${liquidityQuoteAssetUsd(amount, symbol, rates)}`;
        return `${action === "Buy missing " ? "Buy" : "Wrap ETH for"} ${symbol}: ${displayed}, using up to ${liquidityQuoteAmount(eth)} ETH${liquidityQuoteAssetUsd(eth, "ETH", rates)}.`;
      })
    .replace(/^((?:Buy missing|Wrap ETH for) )([^:]+: )(\d+(?:\.\d+)?)( [^:]+: )(\d+(?:\.\d+)?)( ETH maximum\.)$/,
      (_all, action: string, prefix: string, amount: string, separator: string, eth: string, suffix: string) => `${action}${prefix}${liquidityQuoteAmount(amount)}${separator}${liquidityQuoteAmount(eth)}${suffix}`)
    .replace(/^(Convert up to )(\d+(?:\.\d+)?)( spare USDG to at least )(\d+(?:\.\d+)?)( ETH\.)$/,
      (_all, prefix: string, usdg: string, separator: string, eth: string, suffix: string) => `${prefix}${liquidityQuoteUsd(usdg)}${separator}${liquidityQuoteAmount(eth)}${liquidityQuoteAssetUsd(eth, "ETH", rates)}${suffix}`);
}
/** Display only. Signed amounts, slippage, spacing and funding calls stay intact. */
function displayedQuoteSummary(d: LiquidityDraft) {
  const rates = liquidityQuoteUsdRates(d.quoteSummary);
  return d.quoteSummary.filter(line => !/^(?:Wrap ETH for|Estimated gas reserve|Range ticks|Tick-rounded range|MCap uses|Missing assets are bought|Action:|Existing pool:|Pool:|Slippage:|Suggested bands|Bands \(|Each band)/i.test(line))
    .map(line => readableQuoteAmounts(line, rates).replace(/^Buy missing /, "Buy ")
      .replace(/^Initialize a new pool at the quoted reference price if no matching pool exists\.$/, "This will initialize a new pool.")
      .replace(/\s*Tick-rounded range:.*$/i, "")
      .replace(/^Current pool MCap:/, "Current MCap:"));
}
function responseLines(d: LiquidityDraft): string[] {
  const f = d.fields;
  switch (d.phase) {
    case "token": return ["💧 What token would you like to create a liquidity position for? Provide a ticker or contract address."];
    case "budget": return ["💰 What is your position budget?", "", "Example: $100 or 0.1 ETH"];
    case "analysis": return ["⏳ I couldn’t finish comparing pools. Reply refresh to try again, or cancel."];
    case "pool": {
      if (!d.candidates.length) return ["🔎 I couldn’t verify a suitable pool. Reply custom pool to continue, or refresh to check again."];
      const notices = liquidityPoolNotices(d);
      return [
        `💧 Here are the pools I found${d.symbol ? ` for $${d.symbol}` : ""}.`, "",
        ...notices,
        ...(notices.length ? [""] : []),
        ...d.candidates.flatMap((p, i) => [
        `${i + 1}) V${p.version} • ${p.pair} • LP fee ${Number(p.netLpFeePercent.toFixed(5))}%${liquidityHigherRisk(p) ? " • higher risk" : ""}`,
        `Volume: 1h ${p.volumeHourUsd === null ? "unknown" : liquidityCompact(p.volumeHourUsd)} • 24h ${p.volumeDayUsd == null ? "unknown" : liquidityCompact(p.volumeDayUsd)}`,
        `Swap fee ${Number(p.traderFeePercent.toFixed(5))}% • Active depth (±1%): ${p.activeDepthUsd == null ? "unknown" : liquidityCompact(p.activeDepthUsd)}`,
        `Total pool liquidity: ${p.reserveUsd == null ? "unknown" : liquidityCompact(p.reserveUsd)}`,
        ...p.reasons.filter(r => r !== "range_risk").map(r => LIQUIDITY_REASONS[r]), "",
      ]),
      "Choose a number, or respond \"custom pool\" to pick your own settings.",
      ];
    }
    case "pair": return ["💧 Would you like to create an ETH or USDG pool?"];
    case "version": return ["💧 Would you like to use Uniswap V3 or V4?"];
    case "fee": return ["💰 What swap fee would you like? Higher fees earn more per trade but may attract fewer trades.", "",
      f.version === 3 ? "Choose 0.01%, 0.05%, 0.3%, or 1%." : "Choose a percentage up to 10%."];
    // Legacy drafts remain readable, but new setups do not ask this question.
    case "spacing": return ["💧 Tick spacing is chosen automatically. Reply refresh to continue."];
    case "range": return ["📊 What MCap range should your position cover? Provide a lower and upper value around the current MCap.",
      ...(d.currentMarketCapUsd ? ["", `Current MCap: ${formatLiquidityMarketCap(d.currentMarketCapUsd)}`] : []), "",
      "A narrow range concentrates liquidity; a wider range covers more prices. Your liquidity only gathers fees when MCap is inside this range."];
    case "shape": return ["💧 What shape distribution would you like for your liquidity?", "",
      "Flat: Earns fees evenly across the range.", "", "Bell: Earns more fees near the center.", "", "Bid-ask: Earns more fees near the edges."];
    case "bands": return ["⚠️ That band count doesn’t fit. Choose 1–20 for flat, or 3–20 for bell/bid-ask, and ensure your range has room."];
    case "position": return [d.operation === "claim" ? LIQUIDITY_RESPONSES.claimTarget : "💧 Which position would you like to withdraw? This collects fees and closes the whole position.", "",
      ...d.positionChoices.flatMap((p, i) => [`${i + 1}. ${p.positionId} • $${p.symbol} / ${p.pair}`, ""]),
      ...(d.morePositionChoices ? ["Showing 20 matches. You can also enter another owned position ID.", ""] : []),
      "Provide a position ID with or without LP-, or choose a number from this list."];
    case "percentage": return ["💧 Withdrawals close the whole position and collect fees. Reply withdraw or cancel."];
    case "compound": return [LIQUIDITY_RESPONSES.blocked];
    case "review":
      if (d.operation === "claim" || d.operation === "withdraw") return ["⚠️ Your request hasn’t been submitted. Reply refresh to retry, or cancel."];
      return liquiditySections(
        ["💧 Review your liquidity quote"],
        [`Token: $${d.symbol || f.token}${d.tokenAddress ? ` (${d.tokenAddress.slice(0, 6)}...${d.tokenAddress.slice(-4)})` : ""}`,
          ...(f.amount ? [`Position budget: ${f.unit === "usd" ? liquidityQuoteUsd(f.amount) : `${liquidityQuoteAmount(f.amount)} ETH`}`] : [])],
        [`V${f.version} • ${f.pair} • Fee: ${f.feePips! / 10000}%`,
        ...(f.lowerMarketCapUsd !== undefined && f.upperMarketCapUsd !== undefined
          ? [`MCap range: ${formatLiquidityMarketCap(f.lowerMarketCapUsd)} to ${formatLiquidityMarketCap(f.upperMarketCapUsd)}`]
          : f.downPercent !== undefined && f.upPercent !== undefined ? [`Range: ${f.downPercent}% below to ${f.upPercent}% above the reference price`] : []),
          `Shape: ${f.shape === "bid_ask" ? "Bid-ask" : f.shape === "bell" ? "Bell" : "Flat"}`],
        displayedQuoteSummary(d),
      );
    case "blocked": return [d.alternative === "withdraw_all" ? LIQUIDITY_RESPONSES.partialUnavailable : d.operation === "add" ? LIQUIDITY_RESPONSES.addUnavailable : LIQUIDITY_RESPONSES.blocked];
    case "cancelled": return [LIQUIDITY_RESPONSES.cancelled];
    default: return [LIQUIDITY_RESPONSES.help];
  }
}
export function liquidityStepExample(d: LiquidityDraft, _id: string) {
  void _id;
  const examples: Partial<Record<LiquidityDraft["phase"], string>> = {
    token: "$PONSBOT", budget: "$100 or 0.1 ETH",
    pair: "ETH", range: "$50k to $150k",
    review: d.operation === "open" ? "confirm" : "refresh", compound: "cancel",
  };
  const example = examples[d.phase];
  return example ? `Example: ${example}` : "";
}
export function liquidityResponseLines(d: LiquidityDraft, id: string): string[] {
  const lines = responseLines(d);
  const example = liquidityStepExample(d, id);
  return ["token", "budget", "pair", "cancelled", "review", "done"].includes(d.phase) || lines.some(line => line.includes("Example:")) || !example
    ? lines : [...lines, "", example];
}
export function liquidityCompletionGuidance(operation: LiquidityDraft["operation"], positionId?: string) {
  if (operation === "open") return `Use ${positionId || "your position ID"} to check your Delta Liquidity position, collect LP fees, or withdraw.`;
  if (operation === "claim") return "";
  if (operation === "withdraw") return "Your position is closed and its available LP fees were collected.";
  return "";
}
export function liquidityOpenedDetails(d: LiquidityDraft, deposited?: Array<{ symbol: string; amount: string; usd: number }>, depositedUsd?: number, requestedBudgetUsd?: number, partialReprice = false) {
  const f = d.fields;
  const amount = (value: string) => Number(value).toLocaleString("en-US", { maximumSignificantDigits: 7 });
  const funding = deposited?.length && depositedUsd !== undefined
      ? [`Formed position: ${deposited.map(asset => `${amount(asset.amount)} ${asset.symbol} (${liquidityQuoteUsd(String(asset.usd))})`).join(" + ")} • Total $${depositedUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        ...(partialReprice && requestedBudgetUsd ? [`Pool price moved during funding; this is a scaled ${Math.round(depositedUsd / requestedBudgetUsd * 100)}% fill of the requested $${requestedBudgetUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}. Surplus assets remain in your wallet.`] : [])]
      : f.amount ? [`Requested budget: ${f.unit === "usd" ? "$" : ""}${f.amount}${f.unit === "eth" ? " ETH" : ""}`] : [];
  const settings = [
    ...(f.version && f.pair && f.feePips ? [`V${f.version} • ${f.pair} • Fee: ${f.feePips / 10000}%`] : []),
    ...(f.lowerMarketCapUsd !== undefined && f.upperMarketCapUsd !== undefined
      ? [`MCap range: ${formatLiquidityMarketCap(f.lowerMarketCapUsd)} to ${formatLiquidityMarketCap(f.upperMarketCapUsd)}`]
      : f.downPercent !== undefined && f.upPercent !== undefined ? [`Range: ${f.downPercent}% below to ${f.upPercent}% above the reference price`] : []),
    ...(f.shape ? [`Shape: ${f.shape === "bid_ask" ? "Bid-ask" : f.shape === "bell" ? "Bell" : "Flat"}`] : []),
  ];
  return liquiditySections(
    [`Token: $${d.symbol || f.token}${d.tokenAddress ? ` (${d.tokenAddress.slice(0, 6)}...${d.tokenAddress.slice(-4)})` : ""}`],
    funding,
    settings,
  );
}
/** Every X page is shown in full. Never trim away a spending/confirmation term. */
export function paginateLiquidityResponse(lines: string[], source: "x" | "terminal", longForm = false) {
  const normalized = lines.reduce<string[]>((result, line) => {
    if (!line && (!result.length || !result.at(-1))) return result;
    result.push(line);
    return result;
  }, []);
  while (normalized.length && !normalized.at(-1)) normalized.pop();
  if (source === "terminal") return [normalized.join("\n")];
  const limit = longForm ? 7900 : 220, pages: string[] = []; let page = "";
  for (const line of normalized) {
    if (xWeightedLength(line) > limit) throw new Error("Liquidity response line too long");
    if (page && xWeightedLength(`${page}\n${line}`) > limit) { pages.push(page.trimEnd()); page = ""; }
    if (!line && !page) continue;
    page += `${page ? "\n" : ""}${line}`;
  }
  if (page) pages.push(page.trimEnd());
  return pages.map((text, i) => i < pages.length - 1 ? `${text}\nReply next for more (${i + 1}/${pages.length}).` : text);
}
