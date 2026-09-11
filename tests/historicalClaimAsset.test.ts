import {beforeEach,describe,expect,it,vi} from "vitest";
import {encodeEventTopics,encodeAbiParameters,parseAbi} from "viem";
const mocks=vi.hoisted(()=>({read:vi.fn(),receipt:vi.fn(),chain:vi.fn()}));
vi.mock("viem",async original=>({...await original<typeof import("viem")>(),createPublicClient:()=>({readContract:mocks.read,getTransactionReceipt:mocks.receipt,getChainId:mocks.chain})}));
import {recoverHistoricalClaimAsset} from "../lib/historical-claim-asset";
const escrow="0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",asset=`0x${"1".repeat(40)}` as const,hash=`0x${"2".repeat(64)}` as const;
const abi=parseAbi(["event ClaimedToken(address indexed recipient,address indexed token,uint256 amount)"]);
const log=()=>({address:escrow,topics:encodeEventTopics({abi,eventName:"ClaimedToken",args:{recipient:asset,token:asset}}),data:encodeAbiParameters([{type:"uint256"}],[10n**18n])});
beforeEach(()=>{vi.resetAllMocks();mocks.chain.mockResolvedValue(4663);mocks.receipt.mockResolvedValue({status:"success",transactionHash:hash,blockNumber:100n,logs:[log()]});mocks.read.mockImplementation(({functionName})=>Promise.resolve(functionName==="symbol"?"MSFT":18));});
describe("legacy fee asset recovery",()=>{
 it("uses the confirmed escrow event and historical token metadata",async()=>{expect(await recoverHistoricalClaimAsset({transactionHash:hash,blockNumber:"100",assetSymbol:"MSFT",amount:1})).toEqual({assetAddress:asset,rawAmount:"1000000000000000000"});expect(mocks.read.mock.calls.every(([arg])=>arg.blockNumber===100n)).toBe(true);});
 it("rejects a mismatched symbol or amount",async()=>{expect(await recoverHistoricalClaimAsset({transactionHash:hash,assetSymbol:"OTHER",amount:1})).toBeUndefined();expect(await recoverHistoricalClaimAsset({transactionHash:hash,assetSymbol:"MSFT",amount:2})).toBeUndefined();});
 it("does not trust events emitted by another contract",async()=>{mocks.receipt.mockResolvedValue({status:"success",transactionHash:hash,blockNumber:100n,logs:[{...log(),address:asset}]});expect(await recoverHistoricalClaimAsset({transactionHash:hash,assetSymbol:"MSFT",amount:1})).toBeUndefined();});
 it("does not accept another receipt block",async()=>{expect(await recoverHistoricalClaimAsset({transactionHash:hash,blockNumber:"99",assetSymbol:"MSFT",amount:1})).toBeUndefined();});
});
