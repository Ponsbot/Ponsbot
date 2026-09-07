import { z } from "zod";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  isAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  creatorBurnQuoteDigest,
  creatorBurnVaultAbi,
} from "../creator-burn-policy";
import { creatorBurnReceiptEvents } from "../creator-burn-receipts";
import { creatorBurnSignerContext } from "./service";
import {
  estimateResilientAutomationFees,
  transactionGasEnvelope,
  transactionMaximumCost,
} from "./gas";
import { tokenUnitPriceUsd } from "../token-market-cap";
import { ethUsdPrice } from "./pricing";

const address = z.string().refine((v) => isAddress(v, { strict: false }));
const hex = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/);
export const creatorBurnRequest = z
  .object({
    vaultAddress: address,
    layerAddress: address.optional(),
    beneficiary: address.optional(),
    idempotencyKey: z.string().min(8).max(240).optional(),
    stage: z.enum(["collect", "payout", "burn"]).optional(),
    fromBlock: z.string().regex(/^\d+$/).optional(),
    transactionHash: z
      .string()
      .regex(/^0x[\da-fA-F]{64}$/)
      .optional(),
    signedTransaction: hex.optional(),
  })
  .strict();
const registryAbi = parseAbi([
  "function layerOf(address) view returns(address)",
  "function isLayer(address) view returns(bool)",
  "function isVault(address) view returns(bool)",
  "function primaryFactory() view returns(address)",
  "function feeControl() view returns(address)",
  "function executor() view returns(address)",
  "function registry() view returns(address)",
  "function ponsFactory() view returns(address)",
]);
const primaryAbi = parseAbi([
  "function controller() view returns(address)",
  "function beneficiary() view returns(address)",
  "function token() view returns(address)",
  "function pairAsset() view returns(address)",
  "function feeControl() view returns(address)",
  "function ponsFactory() view returns(address)",
  "function claimable(address,address) view returns(uint256)",
]);
const executorAbi = parseAbi([
  "function buyAndBurn(address asset,address token,uint256 amount,uint256 minimum,bytes route) payable returns(uint256)",
]);
const tokenAbi = parseAbi([
  "function approve(address,uint256) returns(bool)",
  "function decimals() view returns(uint8)",
]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function configured(name: string): Address {
  const v = process.env[name]?.trim();
  if (!v || !isAddress(v, { strict: false }))
    throw new Error(`CREATOR_BURN_CONFIGURATION:${name}`);
  return v as Address;
}
function enabled() {
  if (process.env.CREATOR_SELF_BUYBACK_ENABLED !== "true")
    throw new Error("CREATOR_BURN_DISABLED");
}

/** Pinned registry proves provenance. Never trust a caller-supplied layer/owner. */
export async function inspectCreatorBurn(
  vault: Address,
  candidate?: Address,
  block?: bigint,
) {
  if (!process.env.CREATOR_SELF_BUYBACK_FACTORY_ADDRESS?.trim()) {
    if (candidate) throw new Error("CREATOR_BURN_NOT_CONFIGURED");
    return null;
  }
  const { client } = creatorBurnSignerContext();
  if ((await client.getChainId()) !== 4663)
    throw new Error("CREATOR_BURN_WRONG_CHAIN");
  const blockNumber = block ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const factory = configured("CREATOR_SELF_BUYBACK_FACTORY_ADDRESS");
  const latest = await client.readContract({
    address: factory,
    abi: registryAbi,
    functionName: "layerOf",
    args: [vault],
    blockNumber,
  });
  // Unenrolled primary vaults need no new executor configuration or code reads.
  if (!candidate && eq(latest, zeroAddress)) return null;
  const executor = configured("CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS");
  const control = configured("AUTOMATED_FEE_CONTROL_ADDRESS"),
    primaryFactory = configured("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS");
  for (const [a, key] of [
    [factory, "CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH"],
    [executor, "CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH"],
  ] as const) {
    const code = await client.getCode({ address: a, blockNumber });
    const expected = process.env[key]?.toLowerCase();
    if (!expected || !code || keccak256(code) !== expected)
      throw new Error("CREATOR_BURN_CODE_PIN_MISMATCH");
  }
  const read = (
    a: Address,
    f:
      | "layerOf"
      | "isLayer"
      | "isVault"
      | "primaryFactory"
      | "feeControl"
      | "executor"
      | "registry"
      | "ponsFactory",
    args?: readonly [Address],
  ) =>
    client.readContract({
      address: a,
      abi: registryAbi,
      functionName: f,
      args,
      blockNumber,
    });
  const [pf, fc, ex, reg, registered] = await Promise.all([
    read(factory, "primaryFactory"),
    read(factory, "feeControl"),
    read(factory, "executor"),
    read(executor, "registry"),
    read(primaryFactory, "isVault", [vault]),
  ]);
  if (
    !registered ||
    !eq(String(pf), primaryFactory) ||
    !eq(String(fc), control) ||
    !eq(String(ex), executor) ||
    !eq(String(reg), factory)
  )
    throw new Error("CREATOR_BURN_REGISTRY_MISMATCH");
  const layer = (candidate ?? latest) as Address;
  if (eq(layer, zeroAddress)) return null;
  if (!(await read(factory, "isLayer", [layer])))
    throw new Error("CREATOR_BURN_UNKNOWN_LAYER");
  const lr = <
    N extends
      | "upstream"
      | "owner"
      | "asset"
      | "token"
      | "feeControl"
      | "executor"
      | "active"
      | "exited"
      | "selfBurnBps"
      | "configurationNonce"
      | "executionNonce"
      | "MAX_QUOTE_LIFETIME",
  >(
    functionName: N,
  ) =>
    client.readContract({
      address: layer,
      abi: creatorBurnVaultAbi,
      functionName,
      blockNumber,
    });
  const [
    upstream,
    owner,
    asset,
    token,
    lc,
    le,
    active,
    exited,
    bps,
    configurationNonce,
    executionNonce,
    lifetime,
    pc,
    pb,
    pt,
    pa,
    pcontrol,
    pons,
    executorPons,
  ] = await Promise.all([
    lr("upstream"),
    lr("owner"),
    lr("asset"),
    lr("token"),
    lr("feeControl"),
    lr("executor"),
    lr("active"),
    lr("exited"),
    lr("selfBurnBps"),
    lr("configurationNonce"),
    lr("executionNonce"),
    lr("MAX_QUOTE_LIFETIME"),
    ...(
      [
        "controller",
        "beneficiary",
        "token",
        "pairAsset",
        "feeControl",
        "ponsFactory",
      ] as const
    ).map((functionName) =>
      client.readContract({
        address: vault,
        abi: primaryAbi,
        functionName,
        blockNumber,
      }),
    ),
    read(executor, "ponsFactory"),
  ]);
  if (
    !eq(upstream, vault) ||
    !eq(lc, control) ||
    !eq(le, executor) ||
    !eq(String(pcontrol), control) ||
    !eq(token, String(pt)) ||
    !eq(asset, String(pa)) ||
    !eq(String(pons), String(executorPons)) ||
    lifetime !== 600n
  )
    throw new Error("CREATOR_BURN_BINDING_MISMATCH");
  if (
    active &&
    (!eq(String(pc), layer) ||
      !eq(String(pb), layer) ||
      !eq(String(latest), layer))
  )
    throw new Error("CREATOR_BURN_CONTROL_MISMATCH");
  return {
    layer,
    vault,
    owner,
    asset,
    token,
    active,
    exited,
    bps,
    configurationNonce,
    executionNonce,
    executor,
    blockNumber,
    latest: eq(String(latest), layer),
    ponsFactory: String(pons) as Address,
    primaryController: String(pc),
  };
}
export type CreatorLayerSnapshot = NonNullable<
  Awaited<ReturnType<typeof inspectCreatorBurn>>
>;
export async function discoverCreatorBurn(input: unknown) {
  const r = creatorBurnRequest.parse(input),
    s = await inspectCreatorBurn(r.vaultAddress as Address);
  return s ? creatorBurnSnapshot(r) : null;
}

export async function creatorBurnSnapshot(input: unknown) {
  const r = creatorBurnRequest.parse(input),
    s = await inspectCreatorBurn(
      r.vaultAddress as Address,
      r.layerAddress as Address | undefined,
    );
  if (!s) throw new Error("CREATOR_BURN_LAYER_MISSING");
  const { client } = creatorBurnSignerContext();
  const beneficiary = (r.beneficiary ?? s.owner) as Address;
  const [cash, reserve, upstreamClaimable] = await Promise.all([
    client.readContract({
      address: s.layer,
      abi: creatorBurnVaultAbi,
      functionName: "payableTo",
      args: [beneficiary],
      blockNumber: s.blockNumber,
    }),
    client.readContract({
      address: s.layer,
      abi: creatorBurnVaultAbi,
      functionName: "burnReserve",
      args: [beneficiary],
      blockNumber: s.blockNumber,
    }),
    client.readContract({
      address: s.vault,
      abi: primaryAbi,
      functionName: "claimable",
      args: [s.layer, s.asset],
      blockNumber: s.blockNumber,
    }),
  ]);
  return {
    ...s,
    configurationNonce: String(s.configurationNonce),
    executionNonce: String(s.executionNonce),
    blockNumber: String(s.blockNumber),
    beneficiary,
    cash: String(cash),
    reserve: String(reserve),
    upstreamClaimable: String(upstreamClaimable),
  };
}

/** Called under the existing global keeper nonce lease. Persist result BEFORE broadcast. */
export async function prepareCreatorBurn(input: unknown) {
  enabled();
  const r = creatorBurnRequest.parse(input);
  if (!r.stage || !r.idempotencyKey)
    throw new Error("CREATOR_BURN_REQUEST_INCOMPLETE");
  const { client, cdp, role, executionAccess } = creatorBurnSignerContext();
  await executionAccess({ vaultAddress: r.vaultAddress });
  const s = await creatorBurnSnapshot(r),
    beneficiary = s.beneficiary;
  const keeper = await role(
    "AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME",
    "AUTOMATED_FEE_KEEPER_ADDRESS",
  );
  let data: Hex;
  if (r.stage === "collect") {
    if (s.exited) throw new Error("CREATOR_BURN_INACTIVE");
    data = encodeFunctionData({
      abi: creatorBurnVaultAbi,
      functionName: s.active ? "collectAndPay" : "syncDormantOwner",
    });
  } else if (r.stage === "payout") {
    if (BigInt(s.cash) <= 0n) throw new Error("CREATOR_BURN_NO_CASH");
    data = encodeFunctionData({
      abi: creatorBurnVaultAbi,
      functionName: "withdrawFor",
      args: [beneficiary],
    });
  } else {
    if (!s.active || !s.latest || BigInt(s.reserve) <= 0n)
      throw new Error("CREATOR_BURN_NO_RESERVE");
    const launched = await creatorBurnSignerContext().launch(
      s.token,
      s.ponsFactory,
    );
    if (!launched || (launched.phase !== 0 && launched.phase !== 2))
      throw new Error("CREATOR_BURN_GRADUATING");
    const amount = BigInt(s.reserve),
      route = encodeAbiParameters([{ type: "uint8" }], [launched.phase]);
    const calls = [
      ...(eq(s.asset, zeroAddress)
        ? []
        : [
            {
              to: s.asset,
              data: encodeFunctionData({
                abi: tokenAbi,
                functionName: "approve",
                args: [s.executor, amount],
              }),
              value: 0n,
            },
          ]),
      {
        to: s.executor,
        data: encodeFunctionData({
          abi: executorAbi,
          functionName: "buyAndBurn",
          args: [s.asset, s.token, amount, 1n, route],
        }),
        value: eq(s.asset, zeroAddress) ? amount : 0n,
      },
    ];
    const simulation = await client.simulateCalls({
      account: s.layer,
      calls,
      blockNumber: BigInt(s.blockNumber),
      validation: false,
    });
    if (
      simulation.results.length !== calls.length ||
      simulation.results.some((v) => v.status !== "success")
    )
      throw new Error("CREATOR_BURN_QUOTE_SIMULATION_FAILED");
    const last = simulation.results.at(-1)!;
    const out = decodeFunctionResult({
      abi: executorAbi,
      functionName: "buyAndBurn",
      data: last.data,
    });
    const minimumOut = (out * 9700n) / 10000n;
    if (minimumOut <= 0n) throw new Error("CREATOR_BURN_DUST");
    const block = await client.getBlock({ blockNumber: BigInt(s.blockNumber) }),
      issuedAt = block.timestamp,
      deadline = issuedAt + 300n;
    if (BigInt(Math.floor(Date.now() / 1000)) > issuedAt + 60n)
      throw new Error("CREATOR_BURN_STALE_QUOTE");
    const digest = creatorBurnQuoteDigest({
      chainId: 4663n,
      layer: s.layer,
      upstream: s.vault,
      token: s.token,
      asset: s.asset,
      beneficiary,
      amount,
      minimumOut,
      issuedAt,
      deadline,
      executor: s.executor,
      route,
      configurationNonce: BigInt(s.configurationNonce),
      executionNonce: BigInt(s.executionNonce),
    });
    const onchain = await client.readContract({
      address: s.layer,
      abi: creatorBurnVaultAbi,
      functionName: "burnDigest",
      args: [
        beneficiary,
        amount,
        minimumOut,
        issuedAt,
        deadline,
        keccak256(route),
      ],
    });
    if (digest !== onchain) throw new Error("CREATOR_BURN_QUOTE_NONCE_CHANGED");
    const signer = await role(
      "AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME",
      "AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS",
    );
    const { signature } = await cdp.evm.signHash({
      address: signer.address,
      hash: digest,
      idempotencyKey: `creator-burn-quote:${digest}`,
    });
    data = encodeFunctionData({
      abi: creatorBurnVaultAbi,
      functionName: "executeBurn",
      args: [
        beneficiary,
        amount,
        minimumOut,
        issuedAt,
        deadline,
        route,
        signature as Hex,
      ],
    });
  }
  await client.call({ account: keeper.address, to: s.layer, data });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    client.estimateGas({ account: keeper.address, to: s.layer, data }),
    estimateResilientAutomationFees(client),
    client.getTransactionCount({
      address: keeper.address,
      blockTag: "pending",
    }),
    client.getBalance({ address: keeper.address }),
  ]);
  const cost = transactionMaximumCost(0n, estimatedGas, fees.maxFeePerGas);
  if (balance < cost) throw new Error("CREATOR_BURN_KEEPER_UNDERFUNDED");
  if (r.stage === "burn") {
    const [eth, price, decimals] = await Promise.all([
      ethUsdPrice(),
      eq(s.asset, zeroAddress) ? ethUsdPrice() : tokenUnitPriceUsd(s.asset),
      eq(s.asset, zeroAddress)
        ? Promise.resolve(18)
        : client.readContract({
            address: s.asset,
            abi: tokenAbi,
            functionName: "decimals",
          }),
    ]);
    const value =
        Number(formatUnits(BigInt(s.reserve), decimals)) * (price ?? 0),
      gas = Number(formatUnits(cost, 18)) * eth;
    if (
      !Number.isFinite(value) ||
      !Number.isFinite(gas) ||
      gas <= 0 ||
      value < 1 ||
      value < gas * 5
    )
      return { deferred: true as const, reason: "burn_accumulating" };
  }
  const envelope = transactionGasEnvelope(estimatedGas, fees.maxFeePerGas);
  const transaction = {
    chainId: 4663,
    type: "eip1559" as const,
    to: s.layer,
    data,
    value: 0n,
    nonce,
    gas: envelope.gas,
    maxFeePerGas: envelope.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const unsigned = serializeTransaction(transaction);
  // CDP keys identify a payload, not a mutable retry. Preparation never broadcasts;
  // only the exact envelope committed by the worker may subsequently be sent.
  const signingKey = `creator-layer:${keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes" }], [r.idempotencyKey, unsigned]))}`;
  const { signature } = await cdp.evm.signTransaction({
    address: keeper.address,
    transaction: unsigned,
    idempotencyKey: signingKey,
  });
  return {
    transactionHash: keccak256(signature),
    signedTransaction: signature,
    nonce,
    from: keeper.address,
    to: s.layer,
  };
}

export async function broadcastCreatorBurn(input: unknown) {
  enabled();
  const r = creatorBurnRequest.parse(input);
  if (!r.signedTransaction || !r.transactionHash)
    throw new Error("CREATOR_BURN_ENVELOPE_MISSING");
  const { client, executionAccess } = creatorBurnSignerContext();
  await executionAccess({ vaultAddress: r.vaultAddress });
  const tx = parseTransaction(r.signedTransaction as Hex),
    sender = await recoverTransactionAddress({
      serializedTransaction: r.signedTransaction as Parameters<
        typeof recoverTransactionAddress
      >[0]["serializedTransaction"],
    });
  if (
    tx.chainId !== 4663 ||
    !tx.to ||
    !tx.data ||
    (tx.value ?? 0n) !== 0n ||
    !eq(sender, configured("AUTOMATED_FEE_KEEPER_ADDRESS")) ||
    keccak256(r.signedTransaction as Hex) !== r.transactionHash.toLowerCase()
  )
    throw new Error("CREATOR_BURN_ENVELOPE_MISMATCH");
  const s = await inspectCreatorBurn(r.vaultAddress as Address, tx.to);
  if (!s) throw new Error("CREATOR_BURN_LAYER_MISSING");
  const decoded = decodeFunctionData({
    abi: creatorBurnVaultAbi,
    data: tx.data,
  });
  if (
    decoded.functionName !== "collectAndPay" &&
    decoded.functionName !== "syncDormantOwner" &&
    decoded.functionName !== "withdrawFor" &&
    decoded.functionName !== "executeBurn"
  )
    throw new Error("CREATOR_BURN_CALL_NOT_ALLOWED");
  return {
    transactionHash: await client.sendRawTransaction({
      serializedTransaction: r.signedTransaction as Hex,
    }),
  };
}

export async function creatorBurnStatus(input: unknown) {
  const r = creatorBurnRequest.parse(input);
  if (!r.transactionHash || !r.layerAddress)
    throw new Error("CREATOR_BURN_RECEIPT_IDENTITY_MISSING");
  const { client } = creatorBurnSignerContext();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({
      hash: r.transactionHash as Hex,
    });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) {
      if (r.signedTransaction) {
        const tx = parseTransaction(r.signedTransaction as Hex);
        const sender = await recoverTransactionAddress({
          serializedTransaction: r.signedTransaction as Parameters<
            typeof recoverTransactionAddress
          >[0]["serializedTransaction"],
        });
        if (
          keccak256(r.signedTransaction as Hex) !==
            r.transactionHash.toLowerCase() ||
          !eq(sender, configured("AUTOMATED_FEE_KEEPER_ADDRESS")) ||
          tx.chainId !== 4663
        )
          throw new Error("CREATOR_BURN_ENVELOPE_MISMATCH");
        const block = await client.getBlockNumber({ cacheTime: 0 });
        if (
          tx.nonce !== undefined &&
          (await client.getTransactionCount({
            address: sender,
            blockNumber: block - 2n,
          })) > tx.nonce
        )
          return { status: "nonce_consumed" as const };
      }
      return { status: "pending" as const };
    }
    throw e;
  }
  if ((await client.getBlockNumber()) < receipt.blockNumber + 1n)
    return { status: "pending" as const };
  if (receipt.status !== "success")
    return {
      status: "reverted" as const,
      blockNumber: String(receipt.blockNumber),
    };
  const s = await inspectCreatorBurn(
    r.vaultAddress as Address,
    r.layerAddress as Address,
    receipt.blockNumber,
  );
  if (!s) throw new Error("CREATOR_BURN_RECEIPT_BINDING");
  const events = creatorBurnReceiptEvents({
    chainId: 4663,
    layer: s.layer,
    asset: s.asset,
    transactionHash: r.transactionHash as Hex,
    status: receipt.status,
    logs: receipt.logs,
  });
  return {
    status: "confirmed" as const,
    blockNumber: String(receipt.blockNumber),
    gasCostWei: String(receipt.gasUsed * receipt.effectiveGasPrice),
    events: events.map((row) => ({
      ...row,
      received: String(row.received),
      cashAllocated: String(row.cashAllocated),
      reserveAllocated: String(row.reserveAllocated),
      cashDebited: String(row.cashDebited),
      cashReceived: String(row.cashReceived),
      reserveSpent: String(row.reserveSpent),
      tokensBurned: String(row.tokensBurned),
    })),
  };
}

/** Replace only the SAME keeper nonce and SAME call. Either hash may win, never
 * both. All prior hashes remain journaled and checked before another attempt. */
export async function replaceCreatorBurn(input: unknown) {
  enabled();
  const r = creatorBurnRequest.parse(input);
  if (!r.signedTransaction || !r.transactionHash)
    throw new Error("CREATOR_BURN_ENVELOPE_MISSING");
  const signed = r.signedTransaction as Hex,
    tx = parseTransaction(signed);
  const sender = await recoverTransactionAddress({
    serializedTransaction: signed as Parameters<
      typeof recoverTransactionAddress
    >[0]["serializedTransaction"],
  });
  if (
    tx.chainId !== 4663 ||
    !tx.to ||
    !tx.data ||
    tx.nonce === undefined ||
    (tx.value ?? 0n) !== 0n ||
    !eq(sender, configured("AUTOMATED_FEE_KEEPER_ADDRESS")) ||
    keccak256(signed) !== r.transactionHash.toLowerCase()
  )
    throw new Error("CREATOR_BURN_ENVELOPE_MISMATCH");
  await inspectCreatorBurn(r.vaultAddress as Address, tx.to);
  const decoded = decodeFunctionData({
    abi: creatorBurnVaultAbi,
    data: tx.data,
  });
  if (
    ![
      "collectAndPay",
      "withdrawFor",
      "executeBurn",
      "syncDormantOwner",
    ].includes(decoded.functionName)
  )
    throw new Error("CREATOR_BURN_CALL_NOT_ALLOWED");
  const { client, cdp, executionAccess } = creatorBurnSignerContext();
  await executionAccess({ vaultAddress: r.vaultAddress });
  const fees = await estimateResilientAutomationFees(client);
  const bump = (value: bigint) => (value * 1125n) / 1000n + 1n;
  const maxFeePerGas =
    bump(tx.maxFeePerGas ?? 0n) > fees.maxFeePerGas
      ? bump(tx.maxFeePerGas ?? 0n)
      : fees.maxFeePerGas;
  const maxPriorityFeePerGas =
    bump(tx.maxPriorityFeePerGas ?? 0n) > fees.maxPriorityFeePerGas
      ? bump(tx.maxPriorityFeePerGas ?? 0n)
      : fees.maxPriorityFeePerGas;
  if (maxFeePerGas > fees.maxFeePerGas * 3n)
    throw new Error("CREATOR_BURN_REPLACEMENT_FEE_ABOVE_CURRENT_MARKET_CAP");
  const gas = tx.gas!;
  if (
    !gas ||
    (await client.getBalance({ address: sender })) < gas * maxFeePerGas
  )
    throw new Error("CREATOR_BURN_KEEPER_UNDERFUNDED");
  const unsigned = serializeTransaction({
    chainId: 4663,
    type: "eip1559",
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: 0n,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const { signature } = await cdp.evm.signTransaction({
    address: sender,
    transaction: unsigned,
    idempotencyKey: `creator-layer-replacement:${keccak256(unsigned)}`,
  });
  return {
    transactionHash: keccak256(signature),
    signedTransaction: signature,
  };
}

/** Bounded historical ingestion, including owner calls outside the bot. */
export async function creatorBurnHistory(input: unknown) {
  const r = creatorBurnRequest.parse(input),
    s = await inspectCreatorBurn(
      r.vaultAddress as Address,
      r.layerAddress as Address | undefined,
    );
  if (!s) throw new Error("CREATOR_BURN_LAYER_MISSING");
  const { client } = creatorBurnSignerContext();
  const tip = s.blockNumber - 1n;
  let from = r.fromBlock === undefined ? undefined : BigInt(r.fromBlock);
  if (from === undefined) {
    // Locate the creation block once; do not silently omit earlier owner events.
    let low = 0n,
      high = tip;
    while (low < high) {
      const mid = (low + high) / 2n;
      const code = await client.getCode({ address: s.layer, blockNumber: mid });
      if (code && code !== "0x") high = mid;
      else low = mid + 1n;
    }
    from = low;
  }
  if (from > tip)
    return { receipts: [], nextBlock: from.toString(), complete: true };
  let to = from + 1999n < tip ? from + 1999n : tip;
  let hashes: Hex[] = [];
  while (true) {
    const logs = await client.getLogs({
      address: s.layer,
      fromBlock: from,
      toBlock: to,
    });
    hashes = [
      ...new Set(
        logs.map((log) => log.transactionHash).filter((h): h is Hex => !!h),
      ),
    ];
    if (hashes.length <= 100) break;
    if (to === from)
      throw new Error("CREATOR_BURN_HISTORY_SINGLE_BLOCK_TOO_DENSE");
    to = from + (to - from) / 2n;
  }
  const receipts = [];
  for (const hash of hashes) {
    const receipt = await creatorBurnStatus({
      vaultAddress: r.vaultAddress,
      layerAddress: s.layer,
      transactionHash: hash,
    });
    if (receipt.status !== "confirmed")
      throw new Error("CREATOR_BURN_HISTORY_NOT_FINAL");
    receipts.push({ transactionHash: hash, ...receipt });
  }
  return { receipts, nextBlock: (to + 1n).toString(), complete: to === tip };
}

export async function reconcileCreatorDelivery(
  vault: Address,
  layer: Address,
  amount: string,
  fromBlock: string,
  owner?: string,
) {
  let cursor = fromBlock;
  const receipts: Awaited<ReturnType<typeof creatorBurnHistory>>["receipts"] =
    [];
  for (let page = 0; page < 30; page++) {
    const batch = await creatorBurnHistory({
      vaultAddress: vault,
      layerAddress: layer,
      fromBlock: cursor,
    });
    receipts.push(...batch.receipts);
    if (batch.complete) break;
    cursor = batch.nextBlock;
    if (page === 29)
      throw new Error("CREATOR_BURN_DELIVERY_HISTORY_CATCHING_UP");
  }
  const events = receipts.flatMap((r) =>
    r.events.map((e) => ({
      ...e,
      transactionHash: r.transactionHash,
      blockNumber: r.blockNumber,
    })),
  );
  const allocations = events.filter(
    (e) =>
      e.kind === "allocation" &&
      e.received === amount &&
      (!owner || eq(e.owner, owner)),
  );
  if (allocations.length !== 1)
    throw new Error("CREATOR_BURN_DELIVERY_ALLOCATION_NOT_FINAL");
  const allocation = allocations[0];
  const allocationIndex = events.indexOf(allocation);
  const paid = events
    .slice(allocationIndex + 1)
    .find(
      (e) =>
        e.kind === "payout" &&
        eq(e.owner, allocation.owner) &&
        BigInt(e.cashDebited) >= BigInt(allocation.cashAllocated),
    );
  const complete = BigInt(allocation.cashAllocated) === 0n || !!paid;
  const cash =
    paid && BigInt(paid.cashDebited) > 0n
      ? (BigInt(allocation.cashAllocated) * BigInt(paid.cashReceived)) /
        BigInt(paid.cashDebited)
      : 0n;
  return {
    complete,
    amount,
    creatorBurnLayer: layer,
    creatorCashDelivered: cash.toString(),
    creatorReserveAllocated: allocation.reserveAllocated,
    beneficiary: allocation.owner,
    blockNumber: paid?.blockNumber ?? allocation.blockNumber,
    transactionHash: paid?.transactionHash ?? allocation.transactionHash,
    receipts,
  };
}
