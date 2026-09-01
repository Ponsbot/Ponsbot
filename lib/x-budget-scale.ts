// Operator cost control for admission/flood and legacy publication budgets.
// The durable A/B/C publication queue has its own fixed pacing policy and does
// not use this scale. Wallet execution quotas and X headers are unaffected.
export function xReplyBudgetScale() {
  const value = Number(process.env.X_REPLY_BUDGET_SCALE ?? "1");
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 1;
}
