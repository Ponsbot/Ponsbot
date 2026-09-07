import { z } from "zod";
import {
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";
import { creatorBurnSignerContext } from "./service";
import {
  transactionGasEnvelope,
  transactionMaximumCost,
  estimateResilientAutomationFees,
} from "./gas";

const address = z.string().refine((v) => isAddress(v, { strict: false }));
export const layerDeploymentRequest = z
  .object({
    vaultAddress: address,
    expectedOwner: address,
    idempotencyKey: z.string().min(8),
    signedTransaction: z
      .string()
      .regex(/^0x[\da-f]+$/i)
      .optional(),
  })
  .strict();
const abi = parseAbi([
  "function create(address) returns(address)",
  "function layerOf(address) view returns(address)",
  "function controller() view returns(address)",
  "function beneficiary() view returns(address)",
  "function active() view returns(bool)",
  "function primaryFactory() view returns(address)",
  "function isVault(address) view returns(bool)",
  "function feeControl() view returns(address)",
  "function executor() view returns(address)",
  "function registry() view returns(address)",
]);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Read-only preflight before creating a token. This cannot make separate
 * deployment/configuration transactions atomic with the Pons launch. */
export async function creatorLayerLaunchPreflight() {
  if (process.env.CREATOR_SELF_BUYBACK_ENABLED !== "true") throw new Error("CREATOR_BURN_DISABLED");
  const { client, role } = creatorBurnSignerContext();
  if (await client.getChainId() !== 4663) throw new Error("Wrong chain");
  const factory = address.parse(process.env.CREATOR_SELF_BUYBACK_FACTORY_ADDRESS) as Address;
  const executor = address.parse(process.env.CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS) as Address;
  for (const [target, hash] of [[factory, process.env.CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH], [executor, process.env.CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH]] as const) {
    const code = await client.getCode({ address: target });
    if (!code || keccak256(code) !== hash) throw new Error("CREATOR_BURN_CODE_PIN_MISMATCH");
  }
  for (const [target, functionName, expected] of [
    [factory, "primaryFactory", process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS],
    [factory, "feeControl", process.env.AUTOMATED_FEE_CONTROL_ADDRESS],
    [factory, "executor", executor], [executor, "registry", factory],
  ] as const) {
    if (!expected || !eq(await client.readContract({ address: target, abi, functionName }), expected)) throw new Error("CREATOR_BURN_REGISTRY_MISMATCH");
  }
  for (const name of ["ADMIN", "KEEPER"] as const) {
    const account = await role(`AUTOMATED_FEE_${name}_CDP_ACCOUNT_NAME`, `AUTOMATED_FEE_${name}_ADDRESS`);
    if (await client.getBalance({ address: account.address }) === 0n) throw new Error("CREATOR_BURN_SERVICE_UNFUNDED");
  }
  return { ready: true };
}
export async function deployCreatorLayer(input: unknown) {
  const r = layerDeploymentRequest.parse(input);
  const enabled = process.env.CREATOR_SELF_BUYBACK_ENABLED === "true";
  if (!enabled && !r.signedTransaction)
    throw new Error("CREATOR_BURN_DISABLED");
  const { client, role, cdp, executionAccess } = creatorBurnSignerContext();
  await executionAccess({ vaultAddress: r.vaultAddress });
  if ((await client.getChainId()) !== 4663) throw new Error("Wrong chain");
  const factory = process.env.CREATOR_SELF_BUYBACK_FACTORY_ADDRESS as Address;
  const executor = process.env.CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS as Address;
  for (const [a, k] of [
    [factory, "CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH"],
    [executor, "CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH"],
  ] as const) {
    const code = await client.getCode({ address: a });
    if (!code || keccak256(code) !== process.env[k])
      throw new Error("CREATOR_BURN_CODE_PIN_MISMATCH");
  }
  const read = (
    a: Address,
    f:
      | "controller"
      | "beneficiary"
      | "primaryFactory"
      | "feeControl"
      | "executor"
      | "registry",
  ) => client.readContract({ address: a, abi, functionName: f });
  const primary = r.vaultAddress as Address;
  if (
    !eq(
      await read(factory, "primaryFactory"),
      process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS!,
    ) ||
    !eq(
      await read(factory, "feeControl"),
      process.env.AUTOMATED_FEE_CONTROL_ADDRESS!,
    ) ||
    !eq(await read(factory, "executor"), executor) ||
    !eq(await read(executor, "registry"), factory) ||
    !(await client.readContract({
      address: process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS as Address,
      abi,
      functionName: "isVault",
      args: [primary],
    }))
  )
    throw new Error("CREATOR_BURN_REGISTRY_MISMATCH");
  const account = await role(
    "AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME",
    "AUTOMATED_FEE_ADMIN_ADDRESS",
  );
  const data = encodeFunctionData({
    abi,
    functionName: "create",
    args: [primary],
  });
  if (r.signedTransaction) {
    const signed = r.signedTransaction as Hex,
      tx = parseTransaction(signed);
    if (
      !eq(
        await recoverTransactionAddress({
          serializedTransaction: signed as Parameters<
            typeof recoverTransactionAddress
          >[0]["serializedTransaction"],
        }),
        account.address,
      ) ||
      tx.chainId !== 4663 ||
      !tx.to ||
      !eq(tx.to, factory) ||
      tx.data !== data ||
      (tx.value ?? 0n) !== 0n ||
      (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > 3_000_000_000_000_000n
    )
      throw new Error("Layer deployment envelope mismatch");
    const hash = keccak256(signed);
    // Retry only this exact signed envelope. Never replace an uncertain creation.
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (
        (await client.getBlockNumber({ cacheTime: 0 })) <
        receipt.blockNumber + 1n
      )
        return { transactionHash: hash, status: "pending" };
      return {
        transactionHash: hash,
        status: receipt.status === "success" ? "confirmed" : "reverted",
      };
    } catch (e) {
      if ((e as Error).name !== "TransactionReceiptNotFoundError") throw e;
    }
    try {
      await client.getTransaction({ hash });
      return { transactionHash: hash, status: "pending" };
    } catch (e) {
      if ((e as Error).name !== "TransactionNotFoundError") throw e;
    }
    if (!enabled) return { transactionHash: hash, status: "pending" };
    await client.sendRawTransaction({ serializedTransaction: signed });
    return { transactionHash: hash, status: "pending" };
  }
  if (
    !eq(await read(primary, "controller"), r.expectedOwner) ||
    !eq(await read(primary, "beneficiary"), r.expectedOwner) ||
    !(await client.readContract({
      address: primary,
      abi,
      functionName: "active",
    }))
  )
    throw new Error("CREATOR_BURN_ENROLLMENT_OWNER_CHANGED");
  const existing = await client.readContract({
    address: factory,
    abi,
    functionName: "layerOf",
    args: [primary],
  });
  if (!/^0x0{40}$/i.test(existing))
    return { layerAddress: existing, status: "existing" };
  await client.call({ account: account.address, to: factory, data });
  const estimated = await client.estimateGas({
    account: account.address,
    to: factory,
    data,
  });
  const fees = await estimateResilientAutomationFees(client),
    envelope = transactionGasEnvelope(estimated, fees.maxFeePerGas);
  if (
    transactionMaximumCost(0n, estimated, fees.maxFeePerGas) >
    3_000_000_000_000_000n
  )
    throw new Error("Layer deployment exceeds 0.003 ETH ceiling");
  if (
    (await client.getBalance({ address: account.address })) <
    transactionMaximumCost(0n, estimated, fees.maxFeePerGas)
  )
    throw new Error("Layer admin underfunded");
  const nonce = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const tx = serializeTransaction({
    type: "eip1559",
    chainId: 4663,
    to: factory,
    data,
    value: 0n,
    nonce,
    ...envelope,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const { signature } = await cdp.evm.signTransaction({
    address: account.address,
    transaction: tx,
    idempotencyKey: `creator-layer:${keccak256(tx)}`,
  });
  return {
    status: "prepared",
    signedTransaction: signature,
    transactionHash: keccak256(signature),
    nonce,
  };
}
