export function exceedsXReplyDepthLimit(input: {
  replyDepth: number;
  maximumDepth: number;
  guidedWorkflow: boolean;
  liquidityRequest: boolean;
  contextualGasHelp: boolean;
  gasResume: boolean;
}) {
  if (input.replyDepth < input.maximumDepth) return false;
  // Owner-bound guided workflows are intentionally allowed to continue beyond
  // the ordinary anti-loop cutoff. Their own TTL, ownership, per-user workflow
  // allowance, and X account limits remain in force.
  return !input.guidedWorkflow
    && !input.liquidityRequest
    && !input.contextualGasHelp
    && !input.gasResume;
}
