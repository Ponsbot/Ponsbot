import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import { lockDeployment, validateSavedDeployment } from "../scripts/creator-burn-deployment-safety.mjs";

const account=privateKeyToAccount(`0x${"1".padStart(64,"0")}`);
const tx={chainId:4663,type:"eip1559",nonce:3,data:"0x6000",value:0n,gas:100000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1000000n};
const step={name:"executor",nonce:3,data:"0x6000"};

test("exclusive journal lock prevents concurrent deployment and can be released",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"creator-burn-lock-"));
  try {
    const path=join(directory,"journal.json");const release=await lockDeployment(path);
    try {await assert.rejects(lockDeployment(path),{code:"EEXIST"});} finally {await release();}
    const second=await lockDeployment(path);await second();
  } finally {await rmdir(directory);}
});

test("accepts only the saved signed envelope for the authorized deployment",async()=>{
  const signed=await account.signTransaction(tx);
  const record={name:"executor",signed,hash:keccak256(signed)};
  await validateSavedDeployment(record,step,account.address);
  await assert.rejects(validateSavedDeployment({...record,hash:`0x${"0".repeat(64)}`},step,account.address));
  await assert.rejects(validateSavedDeployment(record,{...step,nonce:4},account.address));
  await assert.rejects(validateSavedDeployment(record,{...step,data:"0x6001"},account.address));
  await assert.rejects(validateSavedDeployment(record,step,"0x1111111111111111111111111111111111111111"));
});

test("rejects wrong-chain, value-bearing and over-budget transactions",async()=>{
  for(const change of [{chainId:1},{value:1n},{gas:4000000n}]) {
    const signed=await account.signTransaction({...tx,...change});
    await assert.rejects(validateSavedDeployment({name:"executor",signed,hash:keccak256(signed)},step,account.address));
  }
});
