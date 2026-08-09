import { createPublicClient, encodePacked, http, parseAbi, parseEther, zeroAddress } from "viem";

const rpc = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const factory = process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const router = "0xcaf681a66d020601342297493863e78c959e5cb2";
const quoter = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const sndk = "0xB90A19fF0Af67f7779afF50A882A9CfF42446400";
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const probe = "0x69C3eaDC15Cb2b505193D94e041299cA885A7DA9";
const client = createPublicClient({ transport: http(rpc) });
const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function approvedPairTokens(address) view returns (bool)",
  "function previewLaunchEconomics(uint256,address) view returns (bytes32)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[],uint32[],uint256)",
]);
const routerAbi = parseAbi(["function factory() view returns (address)"]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);

const [chainId, launchFee, launchEnabled, ethEconomics, sndkApproved, sndkEconomics, v3Factory] = await Promise.all([
  client.getChainId(),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "launchEnabled" }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [0n, zeroAddress] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "approvedPairTokens", args: [sndk] }),
  client.readContract({ address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [0n, sndk] }),
  client.readContract({ address: router, abi: routerAbi, functionName: "factory" }),
]);
const fees = [100, 500, 3_000, 10_000];
const pools = {};
for (const fee of fees) {
  pools[`WETH_SNDK_${fee}`] = await client.readContract({ address: v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [weth, sndk, fee] });
  pools[`WETH_USDG_${fee}`] = await client.readContract({ address: v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [weth, usdg, fee] });
  pools[`USDG_SNDK_${fee}`] = await client.readContract({ address: v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [usdg, sndk, fee] });
}
const sndkPath = encodePacked(["address", "uint24", "address", "uint24", "address"], [weth, 100, usdg, 10_000, sndk]);
const sndkQuote = await client.simulateContract({ account: probe, address: quoter, abi: quoterAbi,
  functionName: "quoteExactInput", args: [sndkPath, parseEther("0.001")] });

if (chainId !== 4663) throw new Error(`wrong chain ${chainId}`);
if (!launchEnabled) throw new Error("Pons launches are disabled on-chain");
if (!sndkApproved) throw new Error("SNDK is not an approved Pons pair");
if (launchFee <= 0n || ethEconomics === `0x${"0".repeat(64)}` || sndkEconomics === `0x${"0".repeat(64)}`) {
  throw new Error("Pons launch economics are invalid");
}

console.log(JSON.stringify({ chainId, factory, router, launchFeeWei: launchFee.toString(), launchEnabled,
  sndkApproved, v3Factory, pools, sndkForPoint001Eth: sndkQuote.result[0].toString() }, null, 2));
