import type { JsonSchemaResponseFormat } from "./llm";

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const nullableSlippage = (description: string) => ({
  type: ["integer", "null"], minimum: 10, maximum: 2_000, description,
});

export const walletIntentSchema: JsonSchemaResponseFormat = {
  name: "pons_bot_wallet_intent",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["irrelevant", "unknown_wallet", "question", "command"] },
      operation: {
        type: ["string", "null"],
        enum: [null, "create_wallet", "show_wallet", "show_balance", "send", "burn", "buy", "buy_and_send", "buy_and_burn", "swap_token_for_token", "sell", "claim_fees", "launch"],
        description: "Command operation, or null unless kind is command.",
      },
      topic: {
        type: ["string", "null"],
        enum: [null, "capabilities", "wallet", "fund", "balance", "send", "buy_sell", "burn", "launch", "pairs", "fees"],
        description: "Help topic, or null unless kind is question.",
      },
    },
    required: ["kind", "operation", "topic"],
    additionalProperties: false,
  },
};

const operationProperties: Record<string, Record<string, unknown>> = {
  create_wallet: {},
  show_wallet: {},
  show_balance: { token: nullableString("Explicit ticker or contract address, otherwise null.") },
  send: {
    amount: nullableString("Decimal amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "eth", "usd", "token", "percent"] },
    token: nullableString("Ticker or contract address; null only when the unit does not require it."),
    recipient: nullableString("X handle or complete wallet address, or null when missing."),
  },
  burn: {
    amount: nullableString("Decimal amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "usd", "token", "percent"] },
    token: nullableString("Ticker or complete contract address, or null when missing."),
  },
  buy: {
    amount: nullableString("Decimal spend amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "eth", "usd", "pair"], description: "Use eth whenever the explicit spend asset is ETH. Use pair only for a non-ETH paired asset." },
    token: nullableString("Token being purchased, or null when missing."),
    pairAsset: nullableString("Explicit non-ETH paired spend asset for pair-unit buys, otherwise null. Never return ETH here."),
    slippageBps: nullableSlippage("Slippage in integer basis points; normally 250."),
  },
  buy_and_send: {
    amount: nullableString("Decimal spend amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "eth", "usd", "pair"] },
    token: nullableString("Token being purchased, or null when missing."),
    pairAsset: nullableString("Explicit non-ETH paired spend asset for pair-unit buys, otherwise null."),
    recipient: nullableString("X handle or complete wallet address, or null when missing."),
    slippageBps: nullableSlippage("Slippage in integer basis points; normally 250."),
  },
  buy_and_burn: {
    amount: nullableString("Decimal spend amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "eth", "usd", "pair"], description: "Use eth whenever the explicit spend asset is ETH. Use pair only for a non-ETH paired asset." },
    token: nullableString("Token being purchased and burned, or null when missing."),
    pairAsset: nullableString("Explicit non-ETH paired spend asset for pair-unit buys, otherwise null. Never return ETH here."),
    slippageBps: nullableSlippage("Slippage in integer basis points; normally 250."),
  },
  swap_token_for_token: {
    amount: nullableString("Dollar amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "usd"] },
    fromToken: nullableString("Explicit source ticker or contract address, or null when missing."),
    toToken: nullableString("Explicit destination ticker or contract address, or null when missing."),
    slippageBps: nullableSlippage("Slippage in integer basis points; normally 250."),
  },
  sell: {
    amount: nullableString("Decimal token, percentage, or USD amount without commas, or null when missing."),
    unit: { type: ["string", "null"], enum: [null, "usd", "token", "percent"] },
    token: nullableString("Token being sold, or null when missing."),
    slippageBps: nullableSlippage("Slippage in integer basis points; normally 250."),
  },
  claim_fees: { token: nullableString("Specific launch ticker or contract, otherwise null to claim all eligible fees.") },
  launch: {
    launchMode: { type: ["string", "null"], enum: [null, "pons"] },
    name: nullableString("Exact token name without labels, connectors, or wrapping quotation marks."),
    symbol: nullableString("Uppercase ticker without a leading dollar sign or wrapping quotation marks."),
    description: nullableString("Explicit description without wrapping quotation marks, otherwise null."),
    website: nullableString("Explicit normalized HTTPS website, otherwise null."),
    twitter: nullableString("Explicit normalized https://x.com/handle URL, otherwise null."),
    telegram: nullableString("Explicit normalized https://t.me/name URL, otherwise null."),
    pairToken: nullableString("Explicit pair ticker or contract address, otherwise null."),
    devBuy: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            amount: nullableString("Decimal developer-buy amount without commas."),
            unit: { type: ["string", "null"], enum: [null, "eth", "usd", "pair"] },
          },
          required: ["amount", "unit"],
          additionalProperties: false,
        },
      ],
      description: "Explicit developer buy, otherwise null.",
    },
  },
};

export function walletExtractionSchema(operation: string): JsonSchemaResponseFormat {
  const properties = operationProperties[operation];
  if (!properties) throw new Error(`Unsupported wallet extraction schema: ${operation}`);
  return {
    name: `pons_bot_${operation}_parameters`,
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: [operation, "invalid"] }, ...properties },
      required: ["kind", ...Object.keys(properties)],
      additionalProperties: false,
    },
  };
}
