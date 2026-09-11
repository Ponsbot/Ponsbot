import { createPublicClient, decodeEventLog, formatUnits, http, parseAbi, type Address, type Hex } from "viem";

const escrowAbi = parseAbi(["event ClaimedToken(address indexed recipient,address indexed token,uint256 amount)"]);
const tokenAbi = parseAbi(["function symbol() view returns(string)", "function decimals() view returns(uint8)"]);

/** Recover legacy metadata from the actual escrow event, never a ticker registry. */
export async function recoverHistoricalClaimAsset(input: { transactionHash: string; blockNumber?: string; assetSymbol: string; amount: number }) {
  const publicRpc = "https://rpc.mainnet.chain.robinhood.com";
  try { return await recoverAt(publicRpc, input); }
  catch (error) {
    const fallback = process.env.ROBINHOOD_RPC_URL;
    if (!fallback || fallback === publicRpc) throw error;
    return recoverAt(fallback, input);
  }
}

async function recoverAt(url: string, input: { transactionHash: string; blockNumber?: string; assetSymbol: string; amount: number }) {
  const client = createPublicClient({transport: http(url, {timeout: 8000, retryCount: 1})});
  if(await client.getChainId()!==4663) throw new Error("HISTORICAL_RPC_WRONG_CHAIN");
  const escrow = (process.env.PONS_FEE_ESCROW_ADDRESS || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e").toLowerCase();
  const receipt = await client.getTransactionReceipt({hash: input.transactionHash as Hex});
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()
    || (input.blockNumber && receipt.blockNumber !== BigInt(input.blockNumber))) return undefined;
  const assets = new Map<Address, bigint>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrow) continue;
    try {
      const event = decodeEventLog({abi: escrowAbi, data: log.data, topics: log.topics});
      assets.set(event.args.token, (assets.get(event.args.token) ?? 0n) + event.args.amount);
    } catch { /* Other escrow events are not token claims. */ }
  }
  if (assets.size !== 1) return undefined;
  const [assetAddress, raw] = [...assets][0];
  const [symbol, decimals] = await Promise.all([
    client.readContract({address: assetAddress, abi: tokenAbi, functionName: "symbol", blockNumber: receipt.blockNumber}),
    client.readContract({address: assetAddress, abi: tokenAbi, functionName: "decimals", blockNumber: receipt.blockNumber}),
  ]);
  const amount = Number(formatUnits(raw, decimals));
  if (symbol.toUpperCase() !== input.assetSymbol.toUpperCase() || !Number.isFinite(amount)
    || Math.abs(amount - input.amount) > Math.max(1e-8, input.amount * 1e-7)) return undefined;
  return {assetAddress: assetAddress.toLowerCase(), rawAmount: raw.toString()};
}
