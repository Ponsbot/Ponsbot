import type { LiquidityDraft } from "./liquidity-workflow";
import { liquidityResponseLines, paginateLiquidityResponse } from "./liquidity-responses";

export const LIQUIDITY_HELP_TOPICS = ["step", "basics", "shape", "bands", "range", "price", "fees", "volume", "risk", "pair", "version", "spacing", "funding", "gas", "slippage", "ownership", "management", "one_sided", "review", "ranking", "unsupported"] as const;
export type LiquidityHelpTopic = typeof LIQUIDITY_HELP_TOPICS[number];

// Keep explanations consistent with implemented features:
// no promised returns or unsupported partial/compound operations, or
// assumption that a pool's entire trader fee belongs to ordinary LPs.
export const LIQUIDITY_EXPLANATIONS: Record<Exclude<LiquidityHelpTopic, "step">, readonly string[]> = {
  basics: [
    "💧 Liquidity pools hold two assets so traders can swap between them. Your position supplies some of that liquidity and can earn a share of eligible trading fees.",
    "Earnings depend on trades crossing your active liquidity. No volume means no trading-fee income; owning a position does not guarantee a return.",
  ],
  shape: [
    "💡 Shapes describe how liquidity is distributed inside your chosen range.",
    "Flat (Delta calls it spot): spreads liquidity evenly across the range.",
    "Bell (Delta calls it curve): puts more liquidity near the center of the range, around the price when it is created. It does not automatically follow the price.",
    "Bid-ask: puts more liquidity toward the edges. Less sits near the center. Shape changes where you provide depth; it does not guarantee higher fees.",
  ],
  bands: [
    "💡 Bands split your range into smaller price intervals. Delta Liquidity mints one position NFT per band; our LP ID groups them so you can manage them together.",
    "More bands allow finer distribution but create more NFTs and can cost more gas. Defaults are 1 for flat and 5 for bell/bid-ask. Choose 1–20 for flat or 3–20 for bell/bid-ask at any step.",
    "Even counts use two symmetric center bands; odd counts use one. The selected range and tick spacing must have room for every band.",
  ],
  range: [
    "💡 Your range is entered as dollar market caps, for example $50k to $150k MCap. These are not deposit amounts. Supply and the paired asset’s USD price convert them into pool boundaries.",
    "Choose lower and upper MCap boundaries. The current MCap may be inside or outside them. Refreshing preserves your requested dollar targets.",
    "Inside the range, eligible trades can earn fees. Outside it, the position becomes one-sided and stops earning new trading fees until price re-enters.",
    "A narrow range concentrates capital but can go out of range sooner. A wider range covers more prices but spreads your liquidity more thinly.",
    "The actual boundaries are prices in the paired asset. Its USD price can change the range’s dollar equivalent after opening, especially with ETH pairs.",
  ],
  price: [
    "💡 Price is the value of one token. MCap here is that price multiplied by total token supply. The dollar range is not your deposit budget or a guaranteed sale price.",
    "An existing pool keeps its current price. A new pool is initialized from the verified market reference shown in the quote. The lower range bound does not set the starting price.",
    "Choose lower and upper dollar MCap bounds. Your range decides where liquidity is available, not where the market must trade. Example: $50k to $150k MCap.",
  ],
  fees: [
    "💡 Traders pay a swap fee. Eligible LP fees are shared according to active liquidity, not simply the total dollars in each wallet or position.",
    "Higher fees per trade can discourage routing through that pool. More volume at a lower fee can earn more than a quiet high-fee pool. APR is not guaranteed.",
    "For example, 0.3% on a $100 swap is about $0.30 before fee allocation. Your position earns only its eligible share, not 0.3% of its deposit automatically.",
    "Changing the fee chooses a different pool; it does not edit an existing pool’s settings. A new pool may have no trading activity even with a high fee.",
    "The total trader fee can differ from the LP portion because of protocol splits. Your position receives only its share of the LP portion.",
  ],
  volume: [
    "💡 Volume is how much has traded through a pool. Your share of fees depends on both its fee rate and trades crossing your active price range.",
    "Recent volume is a snapshot, not a forecast. Missing data means unknown, not zero. Volume can also be manipulated, so a busy pool is not automatically a safe pool.",
  ],
  risk: [
    "💡 An LP position holds exposure to both assets. As price moves, swaps change that mix: you may end up with less of the rising asset and more of the falling asset than if you held them separately.",
    "That difference is called impermanent loss. Fees may offset it, but might not. Withdrawing can lock in the difference; token-price and contract risks also remain.",
    "The bot will not sell your chosen token to fund missing ETH/USDG, but once deposited, the pool itself can exchange that token as traders use your liquidity.",
  ],
  pair: [
    "💡 The pair is the second asset alongside your token. Here you can choose ETH or USDG. USDG is a dollar-linked token, not a guarantee of a constant price or risk-free returns.",
    "Both assets affect the position's value. Missing assets can be bought as part of your confirmed quote, using ETH or spare USDG, never by selling the chosen position token.",
  ],
  version: [
    "💡 V3 and V4 are different Uniswap pool systems. Both support concentrated liquidity, but their pool identifiers, fee settings and position contracts differ.",
    "This workflow supports the verified Delta V3 and hookless V4 paths. Choose an available ranked pool or configure a compatible custom one; neither version guarantees better earnings.",
  ],
  spacing: [
    "💡 Tick spacing is the step size between allowed range boundaries. It is not a fee or the number of bands. Smaller spacing allows finer boundary placement.",
    "V3 ties spacing to the fee tier. In V4 it also helps identify the pool. Changing spacing may select a different pool rather than add liquidity to the existing one.",
  ],
  funding: [
    "💡 The budget sizes the position. We use held pool assets first, then quote purchases for missing assets and ETH/USDG conversions. Review the estimated amounts before confirming.",
    "USDG needed for the deposit is reserved. Only spare USDG can be converted to ETH. We never sell your chosen position token to make up a funding shortfall.",
    "Some ETH is needed to start a USDG conversion. If funding is insufficient, add funds and request a refreshed quote; asking a question does not move money.",
  ],
  gas: [
    "💡 Gas is the network transaction cost, paid in Robinhood Chain ETH separately from your deposit. Purchases, approvals, opening, collecting and withdrawing can each use gas.",
    "The quote includes a gas reserve estimate based on simulated steps. Actual costs can change; enough ETH must remain to execute the next transaction.",
  ],
  slippage: [
    "💡 Slippage sets how much execution may differ from the quoted amounts. The workflow uses minimum outputs or maximum inputs; it does not silently increase your tolerance.",
    "A lower tolerance offers a tighter bound but may cause a transaction to fail if prices move. A quote is not a guarantee of execution.",
  ],
  ownership: [
    "💡 Delta Liquidity holds the underlying position NFTs in its manager contract and records your Pons Bot wallet as their beneficial owner. Our workflow checks those ownership records before management actions.",
    "Your LP-XXXXXXXX ID groups the position’s NFTs. You can use it with or without LP- when checking or managing the position.",
    "To see the individual NFTs and their Blockscout links, say: Show me the NFTs for position LP-1234ABCD. This is a read-only lookup.",
  ],
  management: [
    "💡 Use your LP ID to check the position, collect LP fees, or fully withdraw. To invest more, create a separate position. Adding capital to an existing position is not available yet.",
    "Collect by LP ID, token ticker/contract, or all your positions (up to 20 per request). Example: collect all my LP fees. Full withdrawal collects fees first, then closes the position.",
    "For an add request I can offer a new position with matching settings, fresh market pricing and a new budget. Opening that position requires a quote and confirmation.",
    "Withdraw defaults to the whole position and collects its LP fees. Full withdrawals and LP fee claims execute directly once the target is known, without a quote confirmation.",
    "One active position is selected automatically; multiple positions are listed for selection. Explicit partial requests are not silently changed to full withdrawals.",
    "Partial withdrawals and automatic compounding aren’t available yet.",
  ],
  one_sided: [
    "💡 Token-only liquidity sits above the current price, while ETH-only liquidity sits below it. These positions start earning only if trading reaches their ranges.",
    "Trading through the range can convert the deposit into the other asset. A range entirely above or below the current MCap begins one-sided and earns fees only after trading enters it.",
  ],
  review: [
    "💡 Opening a position requires a quote and explicit confirmation. It lists position settings, assets, funding swaps, and gas. Withdrawals and LP fee claims execute directly instead; questions never authorize them.",
    "Questions do not confirm, change your selections, or extend the quote's validity. If it expires while you read, request a fresh quote before confirming.",
    "Funding and deposit steps run sequentially. A later failure does not undo earlier purchases; the result will tell you if some steps completed.",
  ],
  ranking: [
    "💡 Ranked options weigh verified LP fees, recent trading and available liquidity data. Each option has short reasons and a downside; missing metrics are not treated as zero.",
    "An existing pool may already attract trades, but you share fees with its active liquidity. A new pool starts without established volume; a higher fee does not ensure traders will choose it.",
    "Matching the pair, fee and other pool-defining settings uses the same pool. Changing the range or shape creates a different position, not necessarily a new pool.",
  ],
  unsupported: ["💡 I can explain this liquidity setup, its choices and risks. I don’t have a verified answer to that question here. Your selections are unchanged; you can ask about a specific LP setting."],
};

export function liquidityStepTopic(d: LiquidityDraft): LiquidityHelpTopic {
  const topics: Partial<Record<LiquidityDraft["phase"], LiquidityHelpTopic>> = {
    token: "basics", budget: "funding", analysis: "ranking", pool: "ranking", pair: "pair", version: "version", fee: "fees", spacing: "spacing", range: "range", shape: "shape", bands: "bands",
    position: "ownership", percentage: "management", compound: "management", review: "review", blocked: "management",
  };
  return topics[d.phase] ?? "basics";
}

/** Fast path only for clear questions; a polite action request still reaches
 * the parameter extractor. Unfamiliar wording uses its semantic topic router.
 */
export function obviousLiquidityInquiry(text: string): LiquidityHelpTopic[] | undefined {
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").trim();
  const generic = /^(?:please\s+)?(?:what (?:does|do|is) (?:this|that|it|all this)(?: mean)?|explain(?: this| that| it)?|tell me more|i(?:'m| am) confused|i (?:don't|do not) understand)[?.!\s]*$/i;
  if (generic.test(clean)) return ["step"];
  if (!/\b(?:explain|clarify|elaborate|help me understand|talk me through|walk me through|break (?:it|this|that) down|tell me (?:more|about))\b|^(?:what|why|how|which|when|where|who|should i|can i|will|would|does|is|are)\b/i.test(clean)) return undefined;
  const topics: LiquidityHelpTopic[] = [];
  const match = (pattern: RegExp, topic: LiquidityHelpTopic) => { if (pattern.test(clean)) topics.push(topic); };
  match(/\b(?:impermanent loss|risks?|safer|lose|losses|rug)\b/i, "risk");
  match(/\b(?:shapes?|distributions?|flat|spot|bell|curve|bid[ -]?ask)\b/i, "shape");
  match(/\b(?:one[ -]sided|token[ -]only|eth[ -]only)\b/i, "one_sided");
  match(/\b(?:bands?|rungs?)\b/i, "bands"); match(/\b(?:ranges?|out of range|mcap|market cap)\b/i, "range");
  match(/\b(?:prices?|starting price|initial price)\b/i, "price");
  match(/\b(?:gas|network costs?)\b/i, "gas"); match(/\bslippage\b/i, "slippage");
  match(/\b(?:fees?|apr|earnings?|rewards?|income)\b/i, "fees"); match(/\bvolume\b/i, "volume");
  match(/\b(?:rank(?:ed|ing)?|recommendations?|existing|new pool|best pool)\b/i, "ranking");
  match(/\b(?:spacing|ticks?)\b/i, "spacing"); match(/\b(?:v3|v4|versions?)\b/i, "version");
  match(/\b(?:funding|budget|enough|buying|conver(?:t|sion)|missing assets?)\b/i, "funding");
  match(/\b(?:paired?|usdg)\b/i, "pair"); match(/\b(?:nfts?|owner(?:ship)?|lp id|lq id)\b/i, "ownership");
  match(/\b(?:compound(?:ing)?|withdraw(?:al)?|adding|manage)\b/i, "management");
  match(/\b(?:quote|confirm|expir(?:e|es|ed|y)|cancel)\b/i, "review");
  return topics.length ? [...new Set(topics)].slice(0, 3) : undefined;
}

export function liquidityExplanation(draft: LiquidityDraft, id: string, requested: LiquidityHelpTopic[], source: "x" | "terminal") {
  const d = structuredClone(draft);
  const topics = [...new Set(requested.map(topic => topic === "step" ? liquidityStepTopic(d) : topic))];
  const lines = topics.flatMap((topic, topicIndex) => {
    const section = LIQUIDITY_EXPLANATIONS[topic as Exclude<LiquidityHelpTopic, "step">];
    return [...(topicIndex ? [""] : []), ...section.flatMap((line, lineIndex) => [...(lineIndex ? [""] : []), line])];
  });
  const reprompt = d.remainingPages.length ? ["Your choices are saved. Reply next to resume the remaining workflow details."]
    : d.phase === "review" && d.operation !== "open" ? ["Your request is saved. Reply refresh to retry it directly, or cancel.", "Example: refresh"]
    : d.phase === "review" && (!d.review || d.review.expiresAt < Date.now()) ? ["Your choices are saved. Reply refresh for a current quote before confirming.", "Example: refresh"]
    : d.phase === "review" ? ["Your choices are saved. Reply confirm to execute the reviewed quote, or cancel."]
    : d.phase === "shape" ? ["Choose flat, bell, or bid-ask."]
    : liquidityResponseLines(d, id).slice(-2);
  const spacedReprompt = reprompt.flatMap((line, index) => [...(index ? [""] : []), line]);
  const pages = paginateLiquidityResponse([...lines, ...(lines.length && spacedReprompt.length ? [""] : []), ...spacedReprompt], source);
  const message = pages.shift()!;
  // Separate from the financial review queue: explanations cannot consume or
  // overwrite unviewed quote pages, nor replace the quote or its expiry.
  d.explanationPages = pages;
  return { draft: d, message };
}
