/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as llm from "../llm.js";
import type * as ponsV2 from "../ponsV2.js";
import type * as registry from "../registry.js";
import type * as site from "../site.js";
import type * as walletCommands from "../walletCommands.js";
import type * as wallets from "../wallets.js";
import type * as xReplies from "../xReplies.js";
import type * as xReplyPolicy from "../xReplyPolicy.js";
import type * as xText from "../xText.js";
import type * as xWalletAiSchemas from "../xWalletAiSchemas.js";
import type * as xWalletIntent from "../xWalletIntent.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  llm: typeof llm;
  ponsV2: typeof ponsV2;
  registry: typeof registry;
  site: typeof site;
  walletCommands: typeof walletCommands;
  wallets: typeof wallets;
  xReplies: typeof xReplies;
  xReplyPolicy: typeof xReplyPolicy;
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
