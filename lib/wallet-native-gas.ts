import { createPublicClient, http, isAddress, type Address } from "viem";

export const NO_NATIVE_GAS_MESSAGE = "⛽ You'll need to fund your wallet with ETH for gas to complete this transaction. Fund it, then reply “resume”.";

export class EmptyNativeGasBalanceError extends Error {
  constructor() { super("insufficient ETH for gas: wallet has zero native ETH"); }
}

// Convex actions serialize thrown errors, so retain a narrow message check
// for callers receiving an error across that boundary.
export function isEmptyNativeGasBalanceError(error: unknown) {
  return error instanceof EmptyNativeGasBalanceError ||
    (error instanceof Error && error.message.includes("insufficient ETH for gas: wallet has zero native ETH"));
}

export function noNativeGasMessage(address: string, action = "complete this transaction") {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.ponsbot.family").replace(/\/$/, "");
  const message = action === "complete this transaction"
    ? NO_NATIVE_GAS_MESSAGE
    : `⛽ You'll need to fund your wallet with ETH for gas to ${action}. Fund it, then reply “resume”.`;
  return `${message}\nYour wallet: ${site}/wallet/${address}`;
}

/** One balance read, never a gas/price estimate. Fail closed on RPC failure,
 * but don't describe an unavailable balance as an empty wallet. No caching:
 * a user's next request must immediately notice newly received ETH. */
export async function requireNativeGasBalance(readBalance: () => Promise<bigint>) {
  const balance = await readBalance();
  if (balance === 0n) throw new EmptyNativeGasBalanceError();
  if (typeof balance !== "bigint" || balance < 0n) throw new Error("Invalid native ETH balance response");
  return balance;
}

export async function requireWalletNativeGas(address: string) {
  if (!isAddress(address, { strict: false })) throw new Error("Invalid wallet address for native ETH check");
  const client = createPublicClient({ transport: http(
    process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    { timeout: 8_000, retryCount: 1 },
  ) });
  return requireNativeGasBalance(() => client.getBalance({ address: address.toLowerCase() as Address }));
}
