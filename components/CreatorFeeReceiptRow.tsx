import Link from "next/link";
import { formatCreatorFeeAmount, type TerminalFeeReceipt } from "../lib/terminal-fee-receipt";

export function CreatorFeeReceiptRow({ receipt }: { receipt: TerminalFeeReceipt }) {
  const token = receipt.tokenSymbol ? `$${receipt.tokenSymbol.replace(/^\$/, "")}` : `${receipt.tokenAddress.slice(0, 6)}…${receipt.tokenAddress.slice(-4)}`;
  return <tr>
    <td>Creator Fees Received</td>
    <td title={receipt.amount ? `${receipt.amount} ${receipt.assetSymbol || ""}`.trim() : `${receipt.rawAmount} base units`}>{formatCreatorFeeAmount(receipt)}</td>
    <td>{receipt.tokenPageAvailable ? <Link href={`/launch/${receipt.tokenAddress}`}>{token}</Link> : token}</td>
    <td>Automatic</td><td>Confirmed</td>
    <td>{new Date(receipt.createdAt).toLocaleString()}</td>
    <td><a href={`https://robinhoodchain.blockscout.com/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">View TXN ↗</a></td>
  </tr>;
}
