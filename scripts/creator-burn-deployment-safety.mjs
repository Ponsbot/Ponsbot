import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";

export async function lockDeployment(path) {
  const lockPath=path+".lock";
  const file=await open(lockPath,"wx",0o600);
  await file.writeFile(JSON.stringify({pid:process.pid,instance:randomUUID(),createdAt:new Date().toISOString()}));
  return async()=>{await file.close();await unlink(lockPath);};
}
export async function validateSavedDeployment(record,step,admin) {
  if(!record?.signed||record.name!==step.name||keccak256(record.signed)!==record.hash) throw new Error("Deployment journal envelope/hash mismatch");
  const tx=parseTransaction(record.signed);
  const sender=await recoverTransactionAddress({serializedTransaction:record.signed});
  if(sender.toLowerCase()!==admin.toLowerCase()||tx.chainId!==4663||tx.nonce!==step.nonce
    ||(tx.to??"").toLowerCase()!==(step.to??"").toLowerCase()||tx.data!==step.data||(tx.value??0n)!==0n
    ||!tx.gas||!tx.maxFeePerGas||tx.gas*tx.maxFeePerGas>3_000_000_000_000_000n) throw new Error("Deployment journal does not match authorized plan");
}
