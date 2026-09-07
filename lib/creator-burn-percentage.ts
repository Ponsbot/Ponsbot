// This exception is tied to the asset address, never its ticker or caller name.
const PONSBOT = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
export function creatorBurnExecutionBps(tokenAddress: string, requestedBps: number) {
  // 5% + 95% * 47.37% = 50.0015%, nearest representable total to 50%.
  return tokenAddress.toLowerCase() === PONSBOT && requestedBps === 5000 ? 4737 : requestedBps;
}

export function isPonsbotHalfTotal(tokenAddress: string | undefined, executionBps: number) {
  return tokenAddress?.toLowerCase() === PONSBOT && executionBps === 4737;
}
