/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as automatedFeeClaimInfo from "../automatedFeeClaimInfo.js";
import type * as automatedFeeEngine from "../automatedFeeEngine.js";
import type * as automatedFeeOutcomes from "../automatedFeeOutcomes.js";
import type * as automatedFeeQueue from "../automatedFeeQueue.js";
import type * as creatorFeeHistory from "../creatorFeeHistory.js";
import type * as crons from "../crons.js";
import type * as freeLaunches from "../freeLaunches.js";
import type * as graduationAnnouncements from "../graduationAnnouncements.js";
import type * as legacyClaims from "../legacyClaims.js";
import type * as lib_liquiditySchema from "../lib/liquiditySchema.js";
import type * as lib_liquidityWorkflowSchema from "../lib/liquidityWorkflowSchema.js";
import type * as lib_terminalFeeReceipts from "../lib/terminalFeeReceipts.js";
import type * as lib_xReplyQueueSchema from "../lib/xReplyQueueSchema.js";
import type * as lifetimeVolume from "../lifetimeVolume.js";
import type * as liquidity from "../liquidity.js";
import type * as liquidityAi from "../liquidityAi.js";
import type * as liquidityTerminal from "../liquidityTerminal.js";
import type * as llm from "../llm.js";
import type * as marketData from "../marketData.js";
import type * as ponsV2 from "../ponsV2.js";
import type * as registry from "../registry.js";
import type * as site from "../site.js";
import type * as walletCommands from "../walletCommands.js";
import type * as wallets from "../wallets.js";
import type * as xFloodProtection from "../xFloodProtection.js";
import type * as xHoudini from "../xHoudini.js";
import type * as xOperations from "../xOperations.js";
import type * as xPublicationBudget from "../xPublicationBudget.js";
import type * as xReplies from "../xReplies.js";
import type * as xReplyPolicy from "../xReplyPolicy.js";
import type * as xReplyQueue from "../xReplyQueue.js";
import type * as xText from "../xText.js";
import type * as xWalletAiSchemas from "../xWalletAiSchemas.js";
import type * as xWalletIntent from "../xWalletIntent.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  automatedFeeClaimInfo: typeof automatedFeeClaimInfo;
  automatedFeeEngine: typeof automatedFeeEngine;
  automatedFeeOutcomes: typeof automatedFeeOutcomes;
  automatedFeeQueue: typeof automatedFeeQueue;
  creatorFeeHistory: typeof creatorFeeHistory;
  crons: typeof crons;
  freeLaunches: typeof freeLaunches;
  graduationAnnouncements: typeof graduationAnnouncements;
  legacyClaims: typeof legacyClaims;
  "lib/liquiditySchema": typeof lib_liquiditySchema;
  "lib/liquidityWorkflowSchema": typeof lib_liquidityWorkflowSchema;
  "lib/terminalFeeReceipts": typeof lib_terminalFeeReceipts;
  "lib/xReplyQueueSchema": typeof lib_xReplyQueueSchema;
  lifetimeVolume: typeof lifetimeVolume;
  liquidity: typeof liquidity;
  liquidityAi: typeof liquidityAi;
  liquidityTerminal: typeof liquidityTerminal;
  llm: typeof llm;
  marketData: typeof marketData;
  ponsV2: typeof ponsV2;
  registry: typeof registry;
  site: typeof site;
  walletCommands: typeof walletCommands;
  wallets: typeof wallets;
  xFloodProtection: typeof xFloodProtection;
  xHoudini: typeof xHoudini;
  xOperations: typeof xOperations;
  xPublicationBudget: typeof xPublicationBudget;
  xReplies: typeof xReplies;
  xReplyPolicy: typeof xReplyPolicy;
  xReplyQueue: typeof xReplyQueue;
  xText: typeof xText;
  xWalletAiSchemas: typeof xWalletAiSchemas;
  xWalletIntent: typeof xWalletIntent;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
