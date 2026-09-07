// Deploys ONLY dormant infrastructure. Never creates a layer or transfers fee rights.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CdpClient } from "@coinbase/cdp-sdk";
import { randomUUID } from "node:crypto";
import { lockDeployment, validateSavedDeployment } from "./creator-burn-deployment-safety.mjs";
import { createPublicClient, http, parseAbi, getAddress, getContractAddress, encodeDeployData, encodeFunctionData,
  keccak256, stringToHex, serializeTransaction, parseSignature, recoverTransactionAddress } from "viem";

const executing = process.argv.includes("--execute");
const confirm = process.argv[process.argv.indexOf("--confirm") + 1];
const programId = process.argv[process.argv.indexOf("--lease-program") + 1];
const envAddress = (key, fallback = "") => {
  const value=process.env[key]?.trim() || fallback;
  if(!value) throw new Error(key+" is required");
  return getAddress(value);
};
const admin = envAddress("AUTOMATED_FEE_ADMIN_ADDRESS");
const control = envAddress("AUTOMATED_FEE_CONTROL_ADDRESS");
const primaryFactory = envAddress("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
const pons = envAddress("PONS_V2_FACTORY_ADDRESS");
const router = envAddress("PONS_V4_UNIVERSAL_ROUTER_ADDRESS");
const permit = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const holders = envAddress("PONS_HOLDER_DISTRIBUTOR_FACTORY_ADDRESS", "0x70e95CC5f03DB2906081E7a8D16e4C4209291507");
const client = createPublicClient({transport:http(process.env.ROBINHOOD_RPC_URL, {timeout:15000,retryCount:2})});
if (await client.getChainId() !== 4663) throw new Error("Wrong chain");
const getter = parseAbi(["function admin() view returns(address)","function feeControl() view returns(address)","function ponsFactory() view returns(address)","function executor() view returns(address)","function registry() view returns(address)"]);
const read = (address,functionName) => client.readContract({address,abi:getter,functionName});
if (getAddress(await read(control,"admin"))!==admin || getAddress(await read(primaryFactory,"feeControl"))!==control
  || getAddress(await read(primaryFactory,"ponsFactory"))!==pons) throw new Error("Live primary configuration mismatch");
const dependencies = {};
for (const [name,address] of Object.entries({control,primaryFactory,pons,router,permit,holders})) {
  const code=await client.getCode({address});if(!code||code==="0x") throw new Error(name+" has no code");
  dependencies[name]={address,codeHash:keccak256(code)};
}
const artifact = async name => JSON.parse(await readFile(resolve("contracts/out",name+".sol",name+".json"),"utf8"));
const ex=await artifact("PonsBotCreatorBurnExecutor"), fac=await artifact("PonsBotCreatorBurnVaultFactory");
// Keep the original deployed generation's immutable journal intact.
const path=resolve(".deployment-private/creator-burn-foundation-v2.json");
await mkdir(resolve(".deployment-private"),{recursive:true});
// Acquire before reading the journal; do not silently steal a crashed process's lock.
const unlock=executing?await lockDeployment(path):undefined;
let deploymentLeaseHeld=false;
try {
let state;
try {state=JSON.parse(await readFile(path,"utf8"));} catch(e) {if(e.code!=="ENOENT")throw e;}
const nonce=state?.initialNonce ?? await client.getTransactionCount({address:admin,blockTag:"pending"});
const executor=getContractAddress({from:admin,nonce:BigInt(nonce)});
const factory=getContractAddress({from:admin,nonce:BigInt(nonce+1)});
const steps=[
  {name:"executor",nonce,address:executor,data:encodeDeployData({abi:ex.abi,bytecode:ex.bytecode.object,args:[admin,pons,router,permit]})},
  {name:"factory",nonce:nonce+1,address:factory,data:encodeDeployData({abi:fac.abi,bytecode:fac.bytecode.object,args:[primaryFactory,control,executor,holders]})},
  {name:"bind",nonce:nonce+2,to:executor,data:encodeFunctionData({abi:ex.abi,functionName:"bindRegistry",args:[factory]})},
];
const identity={chainId:4663,admin,initialNonce:nonce,dependencies,steps:steps.map(s=>({...s,data:keccak256(s.data)}))};
const confirmationToken=keccak256(stringToHex(JSON.stringify(identity)));
if(state && state.confirmationToken!==confirmationToken) throw new Error("Saved deployment differs from current artifacts/configuration. Do not overwrite it.");
const balance=await client.getBalance({address:admin});
if(!executing) {
  console.log(JSON.stringify({mode:"dry_run",mutationSent:false,confirmationToken,admin,balanceWei:String(balance),executor,factory,
    warning:"Dormant infrastructure only. No token enrollment, owner changes, application deployment or activation.",steps:identity.steps},null,2));
  process.exit(0);
}
if(confirm!==confirmationToken || !process.argv.includes("--lease-program") || !programId) throw new Error("Exact --confirm and --lease-program required");
const leaseId="creator-foundation:"+randomUUID();
function lease(functionName) {
  const args={programId,leaseId,...(functionName.endsWith("acquireDeploymentLease")||functionName.endsWith("completeExternalDeployment")?{externalDeploymentId:confirmationToken}:{})};
  const output=execFileSync(process.execPath,["--use-system-ca","node_modules/convex/bin/main.js","run",functionName,JSON.stringify(args)],{encoding:"utf8",windowsHide:true,timeout:45000});
  if(functionName.endsWith("acquireDeploymentLease")&&!/^true\s*$/.test(output.trim())) throw new Error("Admin deployment lease unavailable");
}
async function save() {await mkdir(resolve(".deployment-private"),{recursive:true});await writeFile(path+".tmp",JSON.stringify(state,null,2)+"\n",{mode:0o600});await rename(path+".tmp",path);}
async function verifyRuntime(address,a) {
  const code=await client.getCode({address}); if(!code||code==="0x")throw new Error("Missing deployment code");
  let observed=code.slice(2),expected=a.deployedBytecode.object.slice(2);
  for(const references of Object.values(a.deployedBytecode.immutableReferences??{})) for(const {start,length} of references) {
    const blank="0".repeat(length*2);observed=observed.slice(0,start*2)+blank+observed.slice((start+length)*2);
    expected=expected.slice(0,start*2)+blank+expected.slice((start+length)*2);
  }
  if(observed!==expected)throw new Error("Deployed runtime differs from compiled artifact");
}
lease("automatedFeeEngine:acquireDeploymentLease");
deploymentLeaseHeld=true;
try {
  const cdp=new CdpClient({apiKeyId:process.env.CDP_API_KEY_ID,apiKeySecret:process.env.CDP_API_KEY_SECRET,walletSecret:process.env.CDP_WALLET_SECRET});
  const account=await cdp.evm.getAccount({name:process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME});
  if(getAddress(account.address)!==admin)throw new Error("CDP account mismatch");
  state??={...identity,confirmationToken,steps:[],status:"in_progress"};await save();
  for(const [i,step] of steps.entries()) {
    lease("automatedFeeEngine:acquireDeploymentLease");
    let record=state.steps[i];
    if(!record?.signed) {
      const latest=await client.getTransactionCount({address:admin,blockTag:"latest"});
      const pending=await client.getTransactionCount({address:admin,blockTag:"pending"});
      if(latest!==step.nonce||pending!==step.nonce)throw new Error("Admin nonce changed or pending. Stop and reconcile.");
      const call={account:admin,...(step.to?{to:step.to}:{}),data:step.data,value:0n};
      await client.call(call);const gas=(await client.estimateGas(call))*110n/100n;
      const fees=await client.estimateFeesPerGas();
      const tx={type:"eip1559",chainId:4663,nonce:step.nonce,...(step.to?{to:step.to}:{}),data:step.data,value:0n,gas,...fees};
      if(!tx.maxFeePerGas||gas*tx.maxFeePerGas>3_000_000_000_000_000n)throw new Error("Deployment exceeds 0.003 ETH per-step ceiling");
      if(await client.getBalance({address:admin})<gas*tx.maxFeePerGas)throw new Error("Admin underfunded");
      const digest=keccak256(serializeTransaction(tx));
      const {signature}=await cdp.evm.signHash({address:admin,hash:digest,idempotencyKey:"creator-foundation:"+digest});
      const signed=serializeTransaction(tx,parseSignature(signature));
      if(getAddress(await recoverTransactionAddress({serializedTransaction:signed}))!==admin)throw new Error("Signature signer mismatch");
      record={name:step.name,hash:keccak256(signed),signed};state.steps[i]=record;await save();
    }
    await validateSavedDeployment(record,step,admin);
    let receipt;
    try {receipt=await client.getTransactionReceipt({hash:record.hash});} catch(e) {if(e.name!=="TransactionReceiptNotFoundError")throw e;}
    if(!receipt) {
      // Reuse the exact saved envelope on retry, never sign another transaction.
      let known=false;try {await client.getTransaction({hash:record.hash});known=true;} catch(e) {if(e.name!=="TransactionNotFoundError")throw e;}
      if(!known) {const hash=await client.sendRawTransaction({serializedTransaction:record.signed});if(hash!==record.hash)throw new Error("Broadcast hash mismatch");}
      receipt=await client.waitForTransactionReceipt({hash:record.hash,confirmations:2,timeout:55000});
    }
    if(receipt.status!=="success")throw new Error("Deployment reverted: "+record.hash);
    if(step.address && getAddress(receipt.contractAddress)!==getAddress(step.address))throw new Error("Creation address mismatch");
    if(i<2) await verifyRuntime(step.address,i===0?ex:fac);
    record.confirmed=true;record.gasUsed=String(receipt.gasUsed);record.gasCostWei=String(receipt.gasUsed*receipt.effectiveGasPrice);await save();
    console.log(step.name+" confirmed: "+record.hash);
  }
  if(getAddress(await read(executor,"registry"))!==getAddress(factory)||getAddress(await read(factory,"executor"))!==getAddress(executor))throw new Error("Registry binding mismatch");
  state.status="deployed_dormant";await save();
  lease("automatedFeeEngine:completeExternalDeployment");
  console.log(JSON.stringify({status:state.status,mutationSent:true,executor,factory,tokenEnrollmentPerformed:false},null,2));
} finally {if(deploymentLeaseHeld)lease("automatedFeeEngine:releaseDeploymentLease");}
} finally {await unlock?.();}
