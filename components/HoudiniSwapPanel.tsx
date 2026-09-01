"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type HoudiniToken = {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  icon?: string;
  price?: number;
  hasCex: boolean;
  enabled: boolean;
};

type Quote = {
  reviewId: string;
  amountOut?: string | number;
  toAmount?: string | number;
  expectedAmount?: string | number;
  expiresAt?: string;
  expiresInMs?: number;
  submissionMarginMs?: number;
  sourceAmount?: string;
  sourceAmountUsd?: string | number;
  amountOutUsd?: string | number;
  duration?: string | number;
  destination?: string;
  privateMode?: boolean;
  targetSymbol?: string;
  targetChain?: string;
};

type Execution = {
  status: string;
  orderId?: string;
  fundingTransactionHash?: string;
  displayStatus?: string;
  statusLabel?: string;
  startedAt?: number;
};

type DestinationPreset = {
  value: string;
  symbol: string;
  chain: string;
  chainAliases: string[];
};

// Deliberately maintained by hand. Houdini token IDs remain API-owned and are
// resolved only when an option is selected, while the public form stays small,
// predictable, and insulated from catalog churn.
const DESTINATION_PRESETS: DestinationPreset[] = [
  {
    value: "eth:robinhood",
    symbol: "ETH",
    chain: "Robinhood Chain",
    chainAliases: ["robinhood"],
  },
  {
    value: "eth:ethereum",
    symbol: "ETH",
    chain: "Ethereum",
    chainAliases: ["ethereum"],
  },
  { value: "eth:base", symbol: "ETH", chain: "Base", chainAliases: ["base"] },
  {
    value: "eth:arbitrum",
    symbol: "ETH",
    chain: "Arbitrum",
    chainAliases: ["arbitrum"],
  },
  {
    value: "eth:optimism",
    symbol: "ETH",
    chain: "Optimism",
    chainAliases: ["optimism"],
  },
  { value: "usdc:base", symbol: "USDC", chain: "Base", chainAliases: ["base"] },
  {
    value: "usdc:ethereum",
    symbol: "USDC",
    chain: "Ethereum",
    chainAliases: ["ethereum"],
  },
  {
    value: "usdc:arbitrum",
    symbol: "USDC",
    chain: "Arbitrum",
    chainAliases: ["arbitrum"],
  },
  {
    value: "usdc:solana",
    symbol: "USDC",
    chain: "Solana",
    chainAliases: ["solana"],
  },
  {
    value: "usdt:ethereum",
    symbol: "USDT",
    chain: "Ethereum",
    chainAliases: ["ethereum"],
  },
  {
    value: "usdt:tron",
    symbol: "USDT",
    chain: "Tron",
    chainAliases: ["tron", "trx"],
  },
  {
    value: "sol:solana",
    symbol: "SOL",
    chain: "Solana",
    chainAliases: ["solana"],
  },
  {
    value: "btc:bitcoin",
    symbol: "BTC",
    chain: "Bitcoin",
    chainAliases: ["bitcoin", "btc"],
  },
  {
    value: "bnb:bsc",
    symbol: "BNB",
    chain: "BNB Chain",
    chainAliases: ["bsc", "binance"],
  },
  {
    value: "avax:avalanche",
    symbol: "AVAX",
    chain: "Avalanche",
    chainAliases: ["avalanche"],
  },
  {
    value: "pol:polygon",
    symbol: "POL",
    chain: "Polygon",
    chainAliases: ["polygon"],
  },
];

function matchesPreset(token: HoudiniToken, preset: DestinationPreset) {
  const chain = token.chain.toLowerCase();
  return (
    token.symbol.toUpperCase() === preset.symbol &&
    preset.chainAliases.some((alias) => chain.includes(alias))
  );
}

function numeric(value: string | number | undefined) {
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function approximateUsd(value: string | number | undefined) {
  const parsed = numeric(value);
  if (parsed === undefined) return "";
  if (parsed > 0 && parsed < 0.01) return " (<$0.01)";
  return ` (${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(parsed)})`;
}

function typedAmountEquivalent(
  amount: string,
  unit: "ETH" | "USD",
  ethUsd: number | undefined,
) {
  const value = numeric(amount);
  if (
    value === undefined ||
    value === 0 ||
    !ethUsd ||
    !Number.isFinite(ethUsd) ||
    ethUsd <= 0
  )
    return "—";
  if (unit === "ETH") {
    const usd = value * ethUsd;
    if (usd > 0 && usd < 0.01) return "(<$0.01)";
    return `(${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(usd)})`;
  }
  const eth = value / ethUsd;
  return `(${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(eth)} ETH)`;
}

function estimatedWait(
  value: string | number | undefined,
  privateMode: boolean,
) {
  const minutes = numeric(value);
  if (minutes !== undefined)
    return `About ${Math.max(1, Math.round(minutes))} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  if (typeof value === "string" && value.trim()) return value.trim();
  return privateMode ? "About 15–45 minutes" : "About 3–30 minutes";
}

function expirationText(expiresAt: string | undefined, now: number) {
  const remaining = expiresAt ? Date.parse(expiresAt) - now : 0;
  if (!expiresAt || !Number.isFinite(remaining)) return "Unavailable";
  if (remaining <= 0) return "Expired";
  const seconds = Math.ceil(remaining / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function friendlyHoudiniStatus(execution: Execution) {
  const raw = (
    execution.displayStatus ||
    execution.statusLabel ||
    execution.status
  )
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const statuses: Record<string, string> = {
    SUBMITTING: "Creating swap order",
    INITIALIZING: "Preparing swap",
    NEW: "Waiting for ETH",
    WAITING: "Waiting for ETH",
    WAITING_FOR_DEPOSIT: "Waiting for ETH",
    AWAITING_FUNDING: "Waiting for ETH",
    FUNDING: "Waiting for ETH confirmation",
    FUNDED: "ETH received, preparing swap",
    CONFIRMING: "Confirming ETH deposit",
    EXCHANGING: "Swap in progress",
    ANONYMIZING: "Private routing in progress",
    SENDING_TO_INTERMEDIARY: "Private routing in progress",
    SENDING_TO_RECEIVER: "Sending to receiving wallet",
    FINISHED: "Completed",
    COMPLETED: "Completed",
    EXPIRED: "Expired",
    FAILED: "Failed",
    REFUNDED: "Refunded",
    DELETED: "Closed",
    UNCERTAIN: "Checking submission",
  };
  return (
    statuses[raw] ||
    raw
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase())
  );
}

function ponsBotSwapStatus(execution: Execution) {
  if (
    execution.fundingTransactionHash ||
    ["funded", "completed"].includes(execution.status)
  )
    return "ETH Sent";
  if (execution.status === "funding") return "Sending ETH";
  if (execution.status === "awaiting_funding") return "ETH Not Sent";
  if (["failed", "uncertain"].includes(execution.status)) return "ETH Not Sent";
  return "Preparing ETH transfer";
}

function waitCountdown(quote: Quote, execution: Execution, now: number) {
  const terminal =
    ["completed", "failed"].includes(execution.status) ||
    [
      "FINISHED",
      "COMPLETED",
      "FAILED",
      "EXPIRED",
      "REFUNDED",
      "DELETED",
    ].includes((execution.statusLabel || "").toUpperCase());
  if (terminal)
    return execution.status === "completed" ||
      ["FINISHED", "COMPLETED"].includes(
        (execution.statusLabel || "").toUpperCase(),
      )
      ? "Completed"
      : "Ended";
  const minutes = numeric(quote.duration) ?? (quote.privateMode ? 30 : 15);
  const startedAt = execution.startedAt || now;
  const remaining = startedAt + minutes * 60_000 - now;
  if (remaining <= 0) return "Taking longer than estimated";
  const seconds = Math.ceil(remaining / 1_000);
  return `About ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining`;
}

export function HoudiniSwapPanel({
  enabled,
  csrfToken,
}: {
  enabled: boolean;
  csrfToken: string;
}) {
  const [privateMode, setPrivateMode] = useState(false);
  const [from, setFrom] = useState<HoudiniToken | null>(null);
  const [to, setTo] = useState<HoudiniToken | null>(null);
  const [toPreset, setToPreset] = useState("");
  const [toLoading, setToLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [amountUnit, setAmountUnit] = useState<"ETH" | "USD">("ETH");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [quoteNeedsReview, setQuoteNeedsReview] = useState(false);
  const [quoteExpired, setQuoteExpired] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [startingAt, setStartingAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const destinationRequest = useRef(0);

  const draftChanged = () => {
    setFormError("");
    if (quote) {
      setQuoteNeedsReview(true);
    }
  };
  const executionStatus = execution?.status;
  const robinhoodEthDestination = toPreset === "eth:robinhood";
  const amountEquivalent = typedAmountEquivalent(
    amount,
    amountUnit,
    from?.price,
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch("/api/houdini/tokens?ethOnly=true", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({ tokens: [] }));
        const source =
          response.ok && Array.isArray(payload.tokens)
            ? payload.tokens.find(
                (token: HoudiniToken) =>
                  token.symbol.toUpperCase() === "ETH" &&
                  /robinhood/i.test(token.chain),
              )
            : undefined;
        if (!controller.signal.aborted)
          setFrom(
            source
              ? {
                  ...source,
                  ...(numeric(payload.ethUsd)
                    ? { price: numeric(payload.ethUsd) }
                    : {}),
                }
              : null,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setFrom(null);
      });
    return () => controller.abort();
  }, [enabled]);
  useEffect(() => {
    if (
      !quote?.reviewId ||
      !executionStatus ||
      ["completed", "failed", "uncertain"].includes(executionStatus)
    )
      return;
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch(
          `/api/houdini/status?reviewId=${encodeURIComponent(quote.reviewId)}`,
          { cache: "no-store", headers: { "x-pons-csrf": csrfToken } },
        );
        const payload = await response.json().catch(() => null);
        if (!stopped && response.ok && payload?.execution)
          setExecution(payload.execution);
      } catch {
        /* Preserve the last durable state during transient outages. */
      }
    };
    const timer = window.setInterval(check, 30_000);
    void check();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [csrfToken, executionStatus, quote?.reviewId]);
  useEffect(() => {
    if (!quote?.expiresAt) return;
    const finished =
      execution &&
      (["completed", "failed"].includes(execution.status) ||
        [
          "FINISHED",
          "COMPLETED",
          "FAILED",
          "EXPIRED",
          "REFUNDED",
          "DELETED",
        ].includes((execution.statusLabel || "").toUpperCase()));
    if (finished) return;
    const tick = () => setClock(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [execution, quote?.expiresAt]);
  if (!enabled) return null;

  const selectDestination = async (value: string) => {
    const requestNumber = ++destinationRequest.current;
    setToPreset(value);
    setTo(null);
    draftChanged();
    const preset = DESTINATION_PRESETS.find((item) => item.value === value);
    if (!preset) {
      setToLoading(false);
      return;
    }
    const requiresPrivateMode = preset.value === "eth:robinhood";
    if (requiresPrivateMode) setPrivateMode(true);
    setToLoading(true);
    try {
      const params = new URLSearchParams(
        requiresPrivateMode
          ? { ethOnly: "true", mode: "private" }
          : { term: preset.symbol, mode: privateMode ? "private" : "standard" },
      );
      const response = await fetch(`/api/houdini/tokens?${params}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({ tokens: [] }));
      const token =
        response.ok && Array.isArray(payload.tokens)
          ? payload.tokens.find((candidate: HoudiniToken) =>
              matchesPreset(candidate, preset),
            )
          : undefined;
      if (requestNumber !== destinationRequest.current) return;
      if (token) setTo(token);
      else
        setFormError(
          `${preset.symbol} on ${preset.chain} is temporarily unavailable.`,
        );
    } catch {
      if (requestNumber === destinationRequest.current)
        setFormError(
          `${preset.symbol} on ${preset.chain} is temporarily unavailable.`,
        );
    } finally {
      if (requestNumber === destinationRequest.current) setToLoading(false);
    }
  };

  const loadQuote = async (previousReviewId?: string) => {
    if (!from || !to) {
      setFormError("Choose both assets from the live Houdini catalog.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const response = await fetch("/api/houdini/quote", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pons-csrf": csrfToken,
        },
        body: JSON.stringify({
          from: from.id,
          to: to.id,
          amount,
          unit: amountUnit,
          destination,
          private: privateMode,
          ...(previousReviewId ? { previousReviewId } : {}),
        }),
      });
      const payload = await response
        .json()
        .catch(() => ({ error: "A quote could not be loaded." }));
      if (!response.ok)
        setFormError(payload.error || "A quote could not be loaded.");
      else {
        setQuote(payload.quote);
        setExecution(null);
        setStartingAt(null);
        setQuoteNeedsReview(false);
        setQuoteExpired(false);
        setClock(Date.now());
        setMessage(
          privateMode
            ? "Your private swap quote. Review details before confirming."
            : "Your multi-chain swap quote. Review details before confirming.",
        );
      }
    } catch {
      setFormError("A quote could not be loaded.");
    } finally {
      setBusy(false);
    }
  };
  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void loadQuote();
  };

  const execute = async () => {
    if (!quote?.reviewId) return;
    setStartingAt(Date.now());
    setBusy(true);
    setMessage("Creating the exchange and preparing wallet funding…");
    try {
      const response = await fetch("/api/houdini/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pons-csrf": csrfToken,
        },
        body: JSON.stringify({ reviewId: quote.reviewId }),
      });
      const payload = await response
        .json()
        .catch(() => ({ error: "The swap could not be started." }));
      if (payload.execution) setExecution(payload.execution);
      if (!response.ok) {
        const error = payload.error || "The swap could not be started.";
        if (/expired|invalid quote/i.test(error)) {
          setQuoteExpired(true);
          setMessage(
            "That quote expired before the exchange was created. Refresh Quote and try again.",
          );
        } else setMessage(error);
      } else
        setMessage(
          "Swap started. Pons Bot is funding the Houdini order from your wallet.",
        );
    } catch {
      setMessage(
        "The swap could not be started. No automatic duplicate submission was made.",
      );
    } finally {
      setBusy(false);
    }
  };

  const expected = quote?.amountOut ?? quote?.toAmount ?? quote?.expectedAmount;
  const receivedUsd =
    quote?.amountOutUsd ??
    (quote?.targetSymbol?.toUpperCase() === "ETH" &&
    expected !== undefined &&
    quote?.sourceAmountUsd &&
    quote.sourceAmount
      ? (Number(expected) * Number(quote.sourceAmountUsd)) /
        Number(quote.sourceAmount)
      : ["USDC", "USDT"].includes(quote?.targetSymbol?.toUpperCase() || "")
        ? expected
        : undefined);
  const quoteRemainingMs = quote?.expiresAt
    ? Date.parse(quote.expiresAt) - clock
    : 0;
  const needsRefresh = Boolean(
    quote && quoteRemainingMs <= (quote.submissionMarginMs ?? 0),
  );
  const quoteRequiresRefresh = Boolean(
    !execution && (needsRefresh || quoteExpired),
  );
  const progressExecution =
    execution ||
    (busy && startingAt
      ? { status: "submitting", startedAt: startingAt }
      : null);
  return (
    <div className="houdini-workspace">
      <section className="houdini-intro">
        <div>
          <a
            className="eyebrow houdini-powered-link"
            href="https://houdiniswap.com/"
            target="_blank"
            rel="noreferrer"
          >
            Powered by Houdini Swap ↗
          </a>
          <h2>Swap across chains</h2>
          <p>
            Send ETH and receive an available asset on your chosen network. No
            browser wallet connection is required - Pons Bot handles everything.
          </p>
        </div>
        <div>
          <div className="houdini-privacy-toggle">
            <span>
              <strong>Private swap</strong>
              <small>
                {robinhoodEthDestination
                  ? "Required when sending Robinhood Chain ETH to another Robinhood Chain address."
                  : "Uses Houdini’s private multi-hop routing when available."}
              </small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={privateMode}
              aria-disabled={robinhoodEthDestination}
              className={privateMode ? "active" : ""}
              onClick={() => {
                if (!robinhoodEthDestination) {
                  setPrivateMode((value) => !value);
                  draftChanged();
                }
              }}
            >
              <i />
            </button>
          </div>
          <details className="houdini-more-info">
            <summary>More Info</summary>
            <div>
              <p>
                <strong>Standard swaps</strong> route your ETH through a
                supported exchange partner and deliver the selected asset to
                your receiving address. Houdini estimates these routes at
                roughly 3–30 minutes.
              </p>
              <p>
                <strong>Private swaps</strong> use an additional routing step
                intended to reduce the direct onchain link between the sending
                and receiving wallets. They generally take about 15–45 minutes
                and cost more than standard routing.
              </p>
              <p>
                The live quote includes the applicable network, routing,
                protocol, and partner fees. Availability, limits, output, and
                timing depend on the selected networks, current market
                conditions, and partner screening.
              </p>
              <p>
                Private routing improves transaction privacy, but should not be
                treated as a guarantee of absolute anonymity.
              </p>
            </div>
          </details>
        </div>
      </section>
      <form className="houdini-form" onSubmit={review}>
        <div className="houdini-wallet-source">
          <span>From your Pons Bot wallet</span>
          <strong>Robinhood Chain ETH</strong>
          <small>
            Your connected wallet supplies the quoted ETH automatically.
          </small>
        </div>
        <label>
          <span>Swap To</span>
          <select
            className="houdini-destination-select"
            value={toPreset}
            onChange={(event) => void selectDestination(event.target.value)}
          >
            <option value="">Select asset and network</option>
            {DESTINATION_PRESETS.map((preset) => (
              <option value={preset.value} key={preset.value}>
                {preset.symbol} on {preset.chain}
              </option>
            ))}
          </select>
          <small>
            {toLoading
              ? "Checking availability…"
              : to
                ? `${to.name} selected`
                : ""}
          </small>
        </label>
        <label>
          <span>Amount</span>
          <div className="houdini-amount-row">
            <div className="houdini-amount-input">
              <input
                required
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  draftChanged();
                }}
                placeholder={amountUnit === "ETH" ? "0.10" : "100.00"}
              />
              <div
                className="houdini-unit-toggle"
                role="group"
                aria-label="Amount unit"
              >
                <button
                  type="button"
                  className={amountUnit === "ETH" ? "active" : ""}
                  aria-pressed={amountUnit === "ETH"}
                  onClick={() => {
                    setAmountUnit("ETH");
                    draftChanged();
                  }}
                >
                  ETH
                </button>
                <button
                  type="button"
                  className={amountUnit === "USD" ? "active" : ""}
                  aria-pressed={amountUnit === "USD"}
                  onClick={() => {
                    setAmountUnit("USD");
                    draftChanged();
                  }}
                >
                  USD
                </button>
              </div>
            </div>
            <output className="houdini-amount-equivalent" aria-live="polite">
              {amountEquivalent}
            </output>
          </div>
        </label>
        <label>
          <span>Receiving wallet address</span>
          <input
            required
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value.trim());
              draftChanged();
            }}
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Destination address on the receiving network"
          />
        </label>
        <div className="houdini-route-summary">
          <span>Route type</span>
          <strong>{privateMode ? "Private" : "Standard multi-chain"}</strong>
          <small>
            Availability, limits, timing, and final output are confirmed by the
            live quote.
          </small>
        </div>
        <button
          className="button button-dark"
          disabled={
            busy || toLoading || !from || !to || !amount || !destination
          }
          type="submit"
        >
          {busy ? "Loading quote…" : "Review quote"}
        </button>
        {formError ? (
          <div className="houdini-form-error" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
      {message && (quote || execution || progressExecution) ? (
        <div
          className={`houdini-result-layout ${progressExecution ? "with-status" : ""}`}
        >
          <div className="houdini-quote">
            <strong>{message}</strong>
            {quote ? (
              <div className="houdini-quote-details">
                <p>
                  <span>You send:</span>
                  <b>
                    {quote.sourceAmount} ETH
                    {approximateUsd(quote.sourceAmountUsd)}
                  </b>
                </p>
                {expected !== undefined && quote.targetSymbol ? (
                  <p>
                    <span>You receive:</span>
                    <b>
                      {expected} {quote.targetSymbol} on{" "}
                      {quote.targetChain || "selected network"}
                      {approximateUsd(receivedUsd)}
                    </b>
                  </p>
                ) : null}
                <p>
                  <span>Receiving address:</span>
                  <b className="houdini-address">
                    {quote.destination || destination}
                  </b>
                </p>
                <p>
                  <span>Estimated wait:</span>
                  <b>
                    {estimatedWait(quote.duration, quote.privateMode === true)}
                  </b>
                </p>
                <p>
                  <span>{execution ? "Quote:" : "Live quote expires:"}</span>
                  <b
                    className={
                      quoteRemainingMs <= 0 && !execution ? "expired" : ""
                    }
                  >
                    {execution
                      ? "Accepted"
                      : expirationText(quote.expiresAt, clock)}
                  </b>
                </p>
              </div>
            ) : null}
            {quote &&
            (!execution || execution.status === "awaiting_funding") ? (
              <div className="houdini-confirm">
                <div className="houdini-confirm-actions">
                  {!execution ? (
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={busy}
                      onClick={() => void loadQuote(quote.reviewId)}
                    >
                      {busy ? "Refreshing…" : "Refresh Quote"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button-dark"
                    disabled={
                      busy ||
                      (!execution && quoteNeedsReview && !quoteRequiresRefresh)
                    }
                    onClick={() =>
                      quoteRequiresRefresh
                        ? void loadQuote(quote.reviewId)
                        : void execute()
                    }
                  >
                    {busy
                      ? quoteRequiresRefresh
                        ? "Refreshing…"
                        : "Starting swap…"
                      : execution
                        ? "Retry wallet funding"
                        : quoteRequiresRefresh
                          ? "Refresh Quote"
                          : quoteNeedsReview
                            ? "Review Changes First"
                            : "Confirm Swap"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {progressExecution && quote ? (
            <aside className="houdini-progress" aria-live="polite">
              <p className="eyebrow">Swap progress</p>
              <h3>{friendlyHoudiniStatus(progressExecution)}</h3>
              <div className="houdini-progress-status">
                <p>
                  <span>Pons Bot</span>
                  <strong>{ponsBotSwapStatus(progressExecution)}</strong>
                </p>
                <p>
                  <span>Houdini Swap</span>
                  <strong>{friendlyHoudiniStatus(progressExecution)}</strong>
                </p>
              </div>
              <div className="houdini-progress-time">
                <span>Estimated wait</span>
                <strong>
                  {waitCountdown(quote, progressExecution, clock)}
                </strong>
              </div>
              {progressExecution.orderId ? (
                <small>Order {progressExecution.orderId}</small>
              ) : null}
              {progressExecution.fundingTransactionHash ? (
                <a
                  href={`https://robinhoodchain.blockscout.com/tx/${progressExecution.fundingTransactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View ETH transaction ↗
                </a>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
