import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { liquidityTables } from "./lib/liquiditySchema";
import { liquidityWorkflowTables } from "./lib/liquidityWorkflowSchema";
import { xReplyQueueTables } from "./lib/xReplyQueueSchema";

const intakeFilterGuardState = v.object({
  recentPosts: v.array(v.object({ id: v.string(), at: v.number() })),
  ownedUntil: v.optional(v.number()),
  activatedAt: v.optional(v.number()),
  lastReleasedAt: v.optional(v.number()),
  triggerCount: v.optional(v.number()),
});

export default defineSchema({
  ...liquidityTables,
  ...liquidityWorkflowTables,
  ...xReplyQueueTables,
  xUnverifiedReplyDays: defineTable({
    xUserId: v.string(), day: v.string(), count: v.number(),
    continuationPostId: v.optional(v.string()),
    continuationUntil: v.optional(v.number()),
    continuationConsumer: v.optional(v.string()),
  }).index("by_user_day", ["xUserId", "day"]),
  xReplyUsers: defineTable({
    xUserId: v.string(),
    username: v.string(),
    verified: v.boolean(),
    verifiedType: v.optional(v.string()),
    subscriptionType: v.optional(v.string()),
    hasSuccessfulLaunch: v.optional(v.boolean()),
    firstSuccessfulLaunchAt: v.optional(v.number()),
    walletId: v.optional(v.id("cryptoWallets")),
    walletStatus: v.union(
      v.literal("none"),
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("frozen"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_x_user_id", ["xUserId"]),

  xReplyInteractions: defineTable({
    postId: v.string(),
    authorXUserId: v.string(),
    authorVerified: v.optional(v.boolean()),
    walletLookupSuppressed: v.optional(v.boolean()),
    replySuppressedReason: v.optional(v.string()),
    walletLookupAdmittedAt: v.optional(v.number()),
    text: v.string(),
    mediaUrl: v.optional(v.string()),
    mediaSource: v.optional(
      v.union(
        v.literal("direct"),
        v.literal("quoted"),
        v.literal("replied_to"),
      ),
    ),
    referencedPostId: v.optional(v.string()),
    referencedPostType: v.optional(
      v.union(v.literal("quoted"), v.literal("replied_to")),
    ),
    nestedReply: v.optional(v.boolean()),
    botParentAuthorized: v.optional(v.boolean()),
    parentPostId: v.optional(v.string()),
    replyDepth: v.optional(v.number()),
    recipientXUserId: v.optional(v.string()),
    recipientAddress: v.optional(v.string()),
    status: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("publishing"),
      v.literal("completed"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    commandKind: v.optional(v.string()),
    parsedIntentJson: v.optional(v.string()),
    guidedHelpStateJson: v.optional(v.string()),
    guidedHelpConsumedByPostId: v.optional(v.string()),
    gasResumeConsumedByPostId: v.optional(v.string()),
    responsePostId: v.optional(v.string()),
    safeError: v.optional(v.string()),
    publicationAttempted: v.optional(v.boolean()),
    publicationQueued: v.optional(v.boolean()),
    publicationStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("published"),
        v.literal("suppressed"),
        v.literal("blocked"),
        v.literal("uncertain"),
        v.literal("failed"),
      ),
    ),
    retryCount: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_post_id", ["postId"])
    .index("by_response_post_id", ["responsePostId"])
    .index("by_status", ["status"])
    .index("by_status_updated_at", ["status", "updatedAt"])
    .index("by_status_next_retry", ["status", "nextRetryAt"]),

  xWalletLookupBudgets: defineTable({
    key: v.string(),
    slots: v.array(v.object({ postId: v.string(), owner: v.string(), at: v.number() })),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  xWorkflowReplyLimits: defineTable({
    ownerXUserId: v.string(),
    slots: v.array(v.object({ postId: v.string(), at: v.number() })),
    cooldownUntil: v.optional(v.number()),
    noticePostId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerXUserId"]),

  xReplyState: defineTable({
    key: v.string(),
    intakeSpikeGuard: v.optional(v.object({
      excludeWalletBalance: v.optional(intakeFilterGuardState),
      verifiedOnly: v.optional(intakeFilterGuardState),
      recentPosts: v.array(v.object({ id: v.string(), at: v.number() })),
      activationCount: v.number(),
      activeUntil: v.optional(v.number()),
      activatedAt: v.optional(v.number()),
      lastReleasedAt: v.optional(v.number()),
      triggerCount: v.optional(v.number()),
    })),
    intakeSource: v.optional(v.string()),
    newestSeenPostId: v.optional(v.string()),
    lastPolledAt: v.optional(v.number()),
    backlogPaginationToken: v.optional(v.string()),
    backlogNewestPostId: v.optional(v.string()),
    backlogVisitedPaginationTokens: v.optional(v.array(v.string())),
    backlogPaginationFailures: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  xReplyRateLimits: defineTable({
    key: v.string(),
    utcDay: v.string(),
    dailyCount: v.number(),
    windowStartedAt: v.number(),
    windowCount: v.number(),
    lastAcceptedAt: v.number(),
    lastCooldownNoticeAt: v.optional(v.number()),
    lastDailyNoticeAt: v.optional(v.number()),
    lastBurstNoticeAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  cryptoWallets: defineTable({
    ownerXUserId: v.string(),
    xUsername: v.optional(v.string()),
    address: v.string(),
    normalizedAddress: v.optional(v.string()),
    signerWalletRef: v.string(),
    chainId: v.number(),
    status: v.union(v.literal("active"), v.literal("frozen")),
    launchEnabled: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_x_user_id", ["ownerXUserId"])
    .index("by_address", ["address"])
    .index("by_normalized_address", ["normalizedAddress"]),

  freeLaunchCampaigns: defineTable({
    key: v.string(),
    enabled: v.boolean(),
    totalSlots: v.number(),
    reservedSlots: v.number(),
    issuedSlots: v.number(),
    completedLaunches: v.number(),
    grantWei: v.string(),
    fundingLeaseToken: v.optional(v.string()),
    fundingLeaseUntil: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  freeLaunchRedemptions: defineTable({
    ownerXUserId: v.string(),
    walletId: v.id("cryptoWallets"),
    recipientAddress: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal("reserved"),
      v.literal("funding"),
      v.literal("funded"),
      v.literal("completed"),
      v.literal("manual_review"),
      v.literal("failed_before_funding"),
    ),
    grantWei: v.string(),
    launchFeeWei: v.optional(v.string()),
    estimatedGas: v.optional(v.string()),
    bufferedGasCostWei: v.optional(v.string()),
    sponsorTransactionHash: v.optional(v.string()),
    fundingBroadcastAt: v.optional(v.number()),
    fundingNotFoundChecks: v.optional(v.number()),
    fundingLastCheckedAt: v.optional(v.number()),
    launchTransactionHash: v.optional(v.string()),
    diagnosticCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_x_user_id", ["ownerXUserId"])
    .index("by_request_id", ["requestId"])
    .index("by_status", ["status"]),

  automatedFeeEngineState: defineTable({
    key: v.string(),
    leaseId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    keeperLeaseId: v.optional(v.string()),
    keeperLeaseUntil: v.optional(v.number()),
    keeperRunId: v.optional(v.id("automatedFeeRuns")),
    keeperControllerRequestId: v.optional(v.string()),
    adminLeaseId: v.optional(v.string()),
    adminLeaseUntil: v.optional(v.number()),
    adminProgramId: v.optional(v.id("automatedFeePrograms")),
    lastStartedAt: v.optional(v.number()),
    lastCompletedAt: v.optional(v.number()),
    lastStatus: v.optional(
      v.union(
        v.literal("disabled"),
        v.literal("not_ready"),
        v.literal("idle"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    lastDiagnosticCode: v.optional(v.string()),
    lifetimeGrossClaimed: v.optional(v.string()),
    lifetimeBeneficiaryDelivered: v.optional(v.string()),
    lifetimeBuybackSpent: v.optional(v.string()),
    lifetimePonsbotBurned: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automatedFeeAssetTotals: defineTable({
    normalizedAssetAddress: v.string(),
    assetAddress: v.string(),
    lifetimeGrossClaimed: v.string(),
    lifetimeBeneficiaryDelivered: v.string(),
    lifetimeBuybackSpent: v.string(),
    updatedAt: v.number(),
  }).index("by_asset", ["normalizedAssetAddress"]),

  automatedFeePrograms: defineTable({
    tokenAddress: v.string(),
    normalizedTokenAddress: v.string(),
    launchId: v.optional(v.id("tokenLaunches")),
    // Operator-only integration tests have no public launch/catalog entry.
    privateTest: v.optional(v.boolean()),
    vaultAddress: v.string(),
    normalizedVaultAddress: v.string(),
    controllerAddress: v.string(),
    normalizedControllerAddress: v.string(),
    beneficiaryAddress: v.string(),
    normalizedBeneficiaryAddress: v.string(),
    pairTokenAddress: v.string(),
    normalizedPairTokenAddress: v.string(),
    distributionMode: v.union(
      v.literal("wallet"),
      v.literal("holders"),
    ),
    enrollmentSource: v.union(v.literal("new_launch"), v.literal("upgrade")),
    enrollmentRequestId: v.optional(v.string()),
    programVersion: v.number(),
    buybackBps: v.number(),
    status: v.union(
      v.literal("prepared"),
      v.literal("enrolled"),
      v.literal("paused"),
      v.literal("exited"),
      v.literal("manual_review"),
    ),
    deploymentSalt: v.string(),
    deploymentTransactionHash: v.optional(v.string()),
    deploymentSignedTransaction: v.optional(v.string()),
    deploymentTransactionNonce: v.optional(v.number()),
    deploymentPreparedAt: v.optional(v.number()),
    deploymentBroadcastAt: v.optional(v.number()),
    deploymentConfirmedAt: v.optional(v.number()),
    deploymentSettledAt: v.optional(v.number()),
    enrollmentTransactionHash: v.optional(v.string()),
    enrollmentAttempts: v.optional(v.number()),
    enrollmentVerificationAttempts: v.optional(v.number()),
    nextEnrollmentAttemptAt: v.optional(v.number()),
    enrollmentDiagnosticCode: v.optional(v.string()),
    enrollmentDiagnosticDetail: v.optional(v.string()),
    flywheelExemptionReason: v.optional(v.literal("holder_fee_sharing")),
    exemptedAt: v.optional(v.number()),
    enrolledAt: v.optional(v.number()),
    scheduleAnchorAt: v.optional(v.number()),
    launchCreatedAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    lastCheckLatenessMs: v.optional(v.number()),
    lastPaidAt: v.optional(v.number()),
    availableCreatorFeesEthWei: v.optional(v.string()),
    availableCreatorFees: v.optional(v.string()),
    accumulationThresholdWei: v.optional(v.string()),
    processingDiagnosticCode: v.optional(v.string()),
    workState: v.optional(v.union(v.literal("idle"), v.literal("waiting"), v.literal("running"))),
    workDueAt: v.optional(v.number()),
    workLeaseId: v.optional(v.string()),
    workGeneration: v.optional(v.number()),
    workLeaseUntil: v.optional(v.number()),
    workRunId: v.optional(v.id("automatedFeeRuns")),
    workAttempts: v.optional(v.number()),
    nextProcessAt: v.optional(v.number()),
    lastProcessAt: v.optional(v.number()),
    lastProcessedBlock: v.optional(v.string()),
    lastControllerChangeTransactionHash: v.optional(v.string()),
    lifetimeGrossClaimed: v.string(),
    lifetimeBeneficiaryAllocated: v.string(),
    lifetimeBuybackSpent: v.string(),
    lifetimePonsbotBurned: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token", ["normalizedTokenAddress"])
    .index("by_vault", ["normalizedVaultAddress"])
    .index("by_controller", ["normalizedControllerAddress"])
    .index("by_beneficiary", ["normalizedBeneficiaryAddress"])
    .index("by_status_next_enrollment", ["status", "nextEnrollmentAttemptAt"])
    .index("by_work_due", ["workState", "workDueAt"])
    .index("by_work_lease", ["workState", "workLeaseUntil"])
    .index("by_status_next_process", ["status", "nextProcessAt"]),

  automatedFeeEnrollmentReservations: defineTable({
    requestId: v.string(),
    predictedTokenAddress: v.string(),
    normalizedPredictedTokenAddress: v.string(),
    predictedVaultAddress: v.string(),
    normalizedPredictedVaultAddress: v.string(),
    controllerAddress: v.string(),
    normalizedControllerAddress: v.string(),
    beneficiaryAddress: v.string(),
    normalizedBeneficiaryAddress: v.string(),
    pairTokenAddress: v.string(),
    normalizedPairTokenAddress: v.string(),
    distributionMode: v.union(v.literal("wallet"), v.literal("holders")),
    deploymentSalt: v.string(),
    status: v.union(v.literal("reserved"), v.literal("bound"), v.literal("cancelled"), v.literal("expired")),
    expiresAt: v.number(),
    boundProgramId: v.optional(v.id("automatedFeePrograms")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_predicted_token", ["normalizedPredictedTokenAddress"])
    .index("by_predicted_vault", ["normalizedPredictedVaultAddress"])
    .index("by_status_expires", ["status", "expiresAt"])
    .index("by_status_updated", ["status", "updatedAt"]),

  automatedFeeControllerChanges: defineTable({
    requestId: v.string(),
    parentRequestId: v.optional(v.string()),
    programId: v.id("automatedFeePrograms"),
    operation: v.union(v.literal("reassign"), v.literal("holders")),
    previousControllerAddress: v.string(),
    newControllerAddress: v.optional(v.string()),
    newBeneficiaryAddress: v.optional(v.string()),
    exitRecipientAddress: v.optional(v.string()),
    ownerXUserId: v.optional(v.string()),
    walletRef: v.optional(v.string()),
    vaultAddress: v.optional(v.string()),
    pairTokenAddress: v.optional(v.string()),
    previousBeneficiaryAddress: v.optional(v.string()),
    transactionHash: v.optional(v.string()),
    signedTransaction: v.optional(v.string()),
    transactionNonce: v.optional(v.number()),
    transactionBroadcastAt: v.optional(v.number()),
    operationJson: v.optional(v.string()),
    deliveryAmount: v.optional(v.string()),
    transactionSettledAt: v.optional(v.number()),
    executionLeaseId: v.optional(v.string()),
    executionLeaseUntil: v.optional(v.number()),
    pendingStatusChecks: v.optional(v.number()),
    workflowCompletedAt: v.optional(v.number()),
    workflowRoot: v.optional(v.boolean()),
    status: v.union(v.literal("reserved"), v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("failed"), v.literal("manual_review")),
    diagnosticCode: v.optional(v.string()),
    diagnosticDetail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_program_status", ["programId", "status"])
    .index("by_owner_status", ["ownerXUserId", "status"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_status_workflow_completed_updated", ["status", "workflowCompletedAt", "updatedAt"])
    .index("by_status_workflow_root_updated", ["status", "workflowRoot", "updatedAt"]),

  automatedFeeRuns: defineTable({
    programId: v.id("automatedFeePrograms"),
    requestedClaim: v.optional(v.boolean()),
    tokenAddress: v.string(),
    vaultAddress: v.string(),
    idempotencyKey: v.string(),
    status: v.union(
      v.literal("reserved"),
      v.literal("submitted"),
      v.literal("confirmed"),
      v.literal("reverted"),
      v.literal("uncertain"),
      v.literal("deferred"),
      v.literal("manual_review"),
    ),
    workflowStage: v.string(),
    pairTokenAddress: v.string(),
    controllerAddress: v.string(),
    beneficiaryAddress: v.string(),
    executionNonce: v.string(),
    phaseAtReservation: v.number(),
    grossClaimed: v.optional(v.string()),
    beneficiaryAllocated: v.optional(v.string()),
    buybackSpent: v.optional(v.string()),
    ponsbotBurned: v.optional(v.string()),
    transactionHash: v.optional(v.string()),
    sweepTransactionHash: v.optional(v.string()),
    sweepSignedTransaction: v.optional(v.string()),
    sweepTransactionNonce: v.optional(v.number()),
    sweepPreparedAt: v.optional(v.number()),
    sweepBroadcastAt: v.optional(v.number()),
    processingTransactionHash: v.optional(v.string()),
    processingSignedTransaction: v.optional(v.string()),
    processingTransactionNonce: v.optional(v.number()),
    processingPreparedAt: v.optional(v.number()),
    processingBroadcastAt: v.optional(v.number()),
    deliveryTransactionHash: v.optional(v.string()),
    deliverySignedTransaction: v.optional(v.string()),
    deliveryTransactionNonce: v.optional(v.number()),
    deliveryPreparedAt: v.optional(v.number()),
    deliveryBroadcastAt: v.optional(v.number()),
    sweepBlockNumber: v.optional(v.string()),
    // Read-only observation, not a fabricated sweep receipt.
    graduatedEscrowReadyBlock: v.optional(v.string()),
    processingBlockNumber: v.optional(v.string()),
    deliveryBlockNumber: v.optional(v.string()),
    beneficiaryDelivered: v.optional(v.string()),
    blockNumber: v.optional(v.string()),
    leaseId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    retryCount: v.number(),
    pendingStatusChecks: v.optional(v.number()),
    recoveryCheckedAt: v.optional(v.number()),
    gasReceipts: v.optional(v.array(v.object({ transactionHash: v.string(), stage: v.string(), costWei: v.string() }))),
    pausedReceiptObservation: v.optional(v.string()),
    pausedReceiptObservedAt: v.optional(v.number()),
    keeperQueuedAt: v.optional(v.number()),
    sweepGasCostWei: v.optional(v.string()),
    processingGasCostWei: v.optional(v.string()),
    deliveryGasCostWei: v.optional(v.string()),
    nextRetryAt: v.optional(v.number()),
    diagnosticCode: v.optional(v.string()),
    diagnosticDetail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_program_created_at", ["programId", "createdAt"])
    .index("by_program_status", ["programId", "status"])
    .index("by_status_recovery", ["status", "recoveryCheckedAt"])
    .index("by_beneficiary_status_updated", ["beneficiaryAddress", "status", "updatedAt"])
    .index("by_status_next_retry", ["status", "nextRetryAt"]),

  // Explicit user claims join the normal keeper queue; never create a second
  // execution path or accept a caller-supplied payout destination.
  automatedFeeClaimRequests: defineTable({
    requestId: v.string(),
    programId: v.id("automatedFeePrograms"),
    walletId: v.id("cryptoWallets"),
    beneficiaryAddress: v.string(),
    tokenSymbol: v.string(),
    assetSymbol: v.string(),
    assetDecimals: v.number(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("no_fees"), v.literal("unavailable")),
    runId: v.optional(v.id("automatedFeeRuns")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_request", ["requestId"])
    .index("by_program_status", ["programId", "status"])
    .index("by_program_status_run", ["programId", "status", "runId"]),

  walletHoldingSnapshots: defineTable({
    walletAddress: v.string(),
    tokenAddress: v.optional(v.string()),
    name: v.string(),
    symbol: v.string(),
    displayBalance: v.string(),
    iconUrl: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_wallet_address", ["walletAddress"])
    .index("by_token_address", ["tokenAddress"]),

  walletRequests: defineTable({
    telegramUpdateId: v.optional(v.string()),
    requestId: v.string(),
    sourcePostId: v.string(),
    ownerXUserId: v.string(),
    walletId: v.id("cryptoWallets"),
    kind: v.string(),
    source: v.optional(v.union(v.literal("x"), v.literal("terminal"), v.literal("telegram"))),
    channel: v.optional(
      v.union(
        v.literal("x_reply"),
        v.literal("terminal_chat"),
        v.literal("terminal_form"),
        v.literal("telegram_chat"),
      ),
    ),
    status: v.union(
      v.literal("accepted"),
      v.literal("simulating"),
      v.literal("prepared"),
      v.literal("broadcast"),
      v.literal("confirmed"),
      v.literal("rejected"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    normalizedJson: v.string(),
    safeError: v.optional(v.string()),
    finalMessage: v.optional(v.string()),
    transactionHash: v.optional(v.string()),
    workflowStage: v.optional(v.string()),
    diagnosticCode: v.optional(v.string()),
    diagnosticDetail: v.optional(v.string()),
    preparedLaunchSalt: v.optional(v.string()),
    predictedTokenAddress: v.optional(v.string()),
    predictedCurveAddress: v.optional(v.string()),
    claimWorkflowJson: v.optional(v.string()),
    claimWorkflowCursor: v.optional(v.number()),
    claimWorkflowVersion: v.optional(v.number()),
    topFiveWorkflowJson: v.optional(v.string()),
    vaultClaimVersion: v.optional(v.number()),
    vaultClaimPreparedAt: v.optional(v.number()),
    vaultClaimOnlyV2: v.optional(v.boolean()),
    limitRefundedAt: v.optional(v.number()),
    reconciliationAttempts: v.optional(v.number()),
    nextReconcileAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_source_post_id", ["sourcePostId"])
    .index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_owner_updated_at", ["ownerXUserId", "updatedAt"]),

  terminalMessages: defineTable({
    sessionId: v.string(),
    ownerXUserId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    messageType: v.union(
      v.literal("chat"),
      v.literal("action"),
      v.literal("result"),
    ),
    text: v.string(),
    requestId: v.optional(v.string()),
    resumeConsumedByRequestId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_session_created_at", ["sessionId", "createdAt"])
    .index("by_session_request_role", ["sessionId", "requestId", "role"]),

  webWalletSessions: defineTable({
    sessionIdHash: v.string(),
    ownerXUserId: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_hash", ["sessionIdHash"])
    .index("by_owner", ["ownerXUserId"]),

  telegramAccountLinks: defineTable({
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    telegramUsername: v.optional(v.string()),
    ownerXUserId: v.string(),
    linkedAt: v.number(),
    lastAuthenticatedAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_telegram_user", ["telegramUserId"])
    .index("by_owner_x_user", ["ownerXUserId"]),

  telegramLinkNonces: defineTable({
    nonceHash: v.string(),
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    telegramUsername: v.optional(v.string()),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_nonce_hash", ["nonceHash"]),

  telegramUpdates: defineTable({
    linkBindingVersion: v.optional(v.number()),
    boundLinkId: v.optional(v.id("telegramAccountLinks")),
    boundOwnerXUserId: v.optional(v.string()),
    updateId: v.string(),
    telegramUserId: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    status: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("ignored"),
      v.literal("failed"),
    ),
    safeError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_update_id", ["updateId"]),

  telegramMessages: defineTable({
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    updateId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_created_at", ["telegramUserId", "createdAt"])
    .index("by_request", ["requestId"]),

  telegramConversations: defineTable({
    resumeText: v.optional(v.string()),
    resumeOwner: v.optional(v.string()),
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    operation: v.string(),
    active: v.boolean(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_active", ["telegramUserId", "active"]),

  terminalRateLimits: defineTable({
    key: v.string(),
    utcDay: v.string(),
    dailyCount: v.number(),
    windowStartedAt: v.number(),
    windowCount: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  xPublicationEvents: defineTable({
    postId: v.string(),
    replyCategory: v.optional(v.union(v.literal("wallet"), v.literal("balance"), v.literal("information"), v.literal("insufficient_eth"), v.literal("other"))),
    status: v.union(
      v.literal("reserved"),
      v.literal("published"),
      v.literal("rejected"),
      v.literal("uncertain"),
    ),
    responsePostId: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    rateLimit: v.optional(v.number()),
    rateLimitRemaining: v.optional(v.number()),
    rateLimitReset: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_created_at", ["createdAt"])
    .index("by_post_id", ["postId"]),

  walletTransactions: defineTable({
    requestId: v.string(),
    walletId: v.id("cryptoWallets"),
    chainId: v.number(),
    to: v.string(),
    valueWei: v.string(),
    callKind: v.string(),
    transactionHash: v.string(),
    signedTransaction: v.optional(v.string()),
    status: v.union(
      v.literal("prepared"),
      v.literal("broadcast"),
      v.literal("confirmed"),
      v.literal("reverted"),
      v.literal("invalid"),
    ),
    blockNumber: v.optional(v.string()),
    claimedDisplay: v.optional(v.string()),
    tradeOutputDisplay: v.optional(v.string()),
    tradeOutputTokenAddress: v.optional(v.string()),
    tradeOutputBalanceBefore: v.optional(v.string()),
    involvedPairTokenAddress: v.optional(v.string()),
    feeReassignmentTokenAddress: v.optional(v.string()),
    feeReassignmentRecipientAddress: v.optional(v.string()),
    feeReassignmentUpdatesLaunch: v.optional(v.boolean()),
    claimIncludesOtherLaunches: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_transaction_hash", ["transactionHash"])
    .index("by_status_created_at", ["status", "createdAt"]),

  tokenLaunches: defineTable({
    requestId: v.string(),
    sourcePostId: v.optional(v.string()),
    ownerXUserId: v.string(),
    launcherUsername: v.optional(v.string()),
    walletId: v.id("cryptoWallets"),
    launchMode: v.literal("pons"),
    name: v.string(),
    symbol: v.string(),
    imageUri: v.string(),
    description: v.optional(v.string()),
    website: v.optional(v.string()),
    twitter: v.optional(v.string()),
    telegram: v.optional(v.string()),
    pairToken: v.optional(v.string()),
    devBuyWei: v.string(),
    transactionHash: v.string(),
    tokenAddress: v.optional(v.string()),
    normalizedTokenAddress: v.optional(v.string()),
    poolAddress: v.optional(v.string()),
    positionId: v.optional(v.string()),
    devBuySucceeded: v.optional(v.boolean()),
    creatorFeeRecipient: v.optional(v.string()),
    normalizedCreatorFeeRecipient: v.optional(v.string()),
    feesReassignedAt: v.optional(v.number()),
    feeReassignmentTransactionHash: v.optional(v.string()),
    holderFeeSharing: v.optional(v.boolean()),
    holderFeeDistributor: v.optional(v.string()),
    holderFeeSharingStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("enabled"),
        v.literal("retrying"),
        v.literal("failed"),
      ),
    ),
    holderFeeSharingAttempts: v.optional(v.number()),
    holderFeeSharingLastError: v.optional(v.string()),
    holderFeeSharingNextAttemptAt: v.optional(v.number()),
    creatorAddress: v.optional(v.string()),
    pairSymbol: v.optional(v.string()),
    publicPublished: v.optional(v.boolean()),
    publicMarketCapUsd: v.optional(v.number()),
    publicMarketCapUpdatedAt: v.optional(v.number()),
    publicVolume24hUsd: v.optional(v.number()),
    publicVolume24hUpdatedAt: v.optional(v.number()),
    publicLastBuyAt: v.optional(v.number()),
    publicGraduated: v.optional(v.boolean()),
    publicGraduationUpdatedAt: v.optional(v.number()),
    graduationAnnouncementStatus: v.optional(
      v.union(
        v.literal("monitoring"),
        v.literal("posting"),
        v.literal("posted"),
        v.literal("ignored"),
        v.literal("uncertain"),
      ),
    ),
    graduationAnnouncementAttemptedAt: v.optional(v.number()),
    graduationAnnouncementPostedAt: v.optional(v.number()),
    graduationAnnouncementPostId: v.optional(v.string()),
    graduationAnnouncementNextAttemptAt: v.optional(v.number()),
    graduationAnnouncementError: v.optional(v.string()),
    graduationMonitorCheckedAt: v.optional(v.number()),
    graduationMonitorNextCheckAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_creator_fee_recipient", ["normalizedCreatorFeeRecipient"])
    .index("by_token_address", ["tokenAddress"])
    .index("by_normalized_token_address", ["normalizedTokenAddress"])
    .index("by_symbol", ["symbol"])
    .index("by_created_at", ["createdAt"])
    .index("by_public_created_at", ["publicPublished", "createdAt"])
    .index("by_public_market_cap", ["publicPublished", "publicMarketCapUsd"])
    .index("by_public_volume", ["publicPublished", "publicVolume24hUsd"])
    .index("by_public_last_buy", ["publicPublished", "publicLastBuyAt"])
    .index("by_graduation_due", [
      "graduationAnnouncementStatus",
      "graduationMonitorNextCheckAt",
    ])
    .searchIndex("search_public_name", {
      searchField: "name",
      filterFields: ["publicPublished"],
    })
    .searchIndex("search_public_symbol", {
      searchField: "symbol",
      filterFields: ["publicPublished"],
    }),

  tokenActivity: defineTable({
    tokenAddress: v.string(),
    normalizedTokenAddress: v.string(),
    transactionHash: v.string(),
    logIndex: v.number(),
    kind: v.union(v.literal("buy"), v.literal("sell"), v.literal("burn")),
    walletAddress: v.string(),
    tokenAmount: v.string(),
    marketCapUsd: v.optional(v.number()),
    usdAmount: v.optional(v.number()),
    volumeBucketed: v.optional(v.boolean()),
    blockNumber: v.string(),
    timestamp: v.number(),
    createdAt: v.number(),
  })
    .index("by_token_time", ["normalizedTokenAddress", "timestamp"])
    .index("by_token_bucketed_time", [
      "normalizedTokenAddress",
      "volumeBucketed",
      "timestamp",
    ])
    .index("by_transaction_log", ["transactionHash", "logIndex"]),

  tokenVolumeBuckets: defineTable({
    normalizedTokenAddress: v.string(),
    hourStartedAt: v.number(),
    volumeUsd: v.number(),
    updatedAt: v.number(),
  }).index("by_token_hour", ["normalizedTokenAddress", "hourStartedAt"]),

  lifetimeVolumeWorker: defineTable({
    key: v.string(),
    generation: v.number(),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    scheduledAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    blockedUntil: v.optional(v.number()),
    throttleCount: v.number(),
    discoveryAt: v.optional(v.number()),
    lastCompletedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    importManifestId: v.optional(v.string()),
    importCutoffHour: v.optional(v.number()),
    importExpectedSources: v.optional(v.number()),
    importCompletedSources: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  tokenLifetimeVolumes: defineTable({
    tokenAddress: v.string(),
    normalizedTokenAddress: v.string(),
    source: v.optional(
      v.union(v.literal("bonding_curve"), v.literal("v4_pool")),
    ),
    frozen: v.optional(v.boolean()),
    pairToken: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    graduationObservedAt: v.optional(v.number()),
    revision: v.optional(v.number()),
    volumeProvider: v.optional(v.union(v.literal("gecko"), v.literal("onchain"))),
    bucketedThroughAt: v.optional(v.number()),
    onchainTrackingStartedAt: v.optional(v.number()),
    bucketRecentJson: v.optional(v.string()),
    backfillManifestId: v.optional(v.string()),
    poolAddress: v.string(),
    normalizedPoolAddress: v.string(),
    launchCreatedAt: v.number(),
    confirmedVolumeUsd: v.number(),
    provisionalVolumeUsd: v.number(),
    recentHoursJson: v.string(),
    oldestBackfilledHour: v.optional(v.number()),
    latestCompletedHour: v.optional(v.number()),
    backfillBeforeTimestamp: v.optional(v.number()),
    backfillComplete: v.boolean(),
    nextCheckAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pool", ["normalizedPoolAddress"])
    .index("by_token", ["normalizedTokenAddress"])
    .index("by_enabled_due", ["enabled", "nextCheckAt"])
    .index("by_due", ["nextCheckAt"]),

  tokenMarketState: defineTable({
    tokenAddress: v.string(),
    normalizedTokenAddress: v.string(),
    lastBuyAt: v.optional(v.number()),
    marketCapUsd: v.optional(v.number()),
    marketCapUpdatedAt: v.optional(v.number()),
    marketCapSource: v.optional(
      v.union(v.literal("gecko"), v.literal("onchain")),
    ),
    volume24hUsd: v.optional(v.number()),
    volume24hUpdatedAt: v.optional(v.number()),
    lastTradeAt: v.optional(v.number()),
    graduated: v.optional(v.boolean()),
    graduationUpdatedAt: v.optional(v.number()),
    poolFee: v.optional(v.number()),
    tickSpacing: v.optional(v.number()),
    graduationCheckedAt: v.optional(v.number()),
    activityBackfilledAt: v.optional(v.number()),
    volumeBucketsInitializedAt: v.optional(v.number()),
    recentEventKeys: v.optional(v.array(v.string())),
    indexedThroughBlock: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_normalized_token", ["normalizedTokenAddress"])
    .index("by_last_buy", ["lastBuyAt"]),

  websiteRefreshJobs: defineTable({
    token: v.string(), leaseId: v.string(), leaseUntil: v.number(), retryAt: v.number(),
  }).index("by_token", ["token"]),

  websiteReadCache: defineTable({
    key: v.string(), json: v.optional(v.string()), observedAt: v.optional(v.number()),
    expiresAt: v.number(), leaseId: v.optional(v.string()), leaseUntil: v.optional(v.number()),
    retryAt: v.optional(v.number()),
  }).index("by_key", ["key"]).index("by_expiry", ["expiresAt"]),

  // Display-only snapshots. Independent of trading, fee cycles and volume accounting.
  websiteActivitySnapshots: defineTable({
    token: v.string(), kind: v.union(v.literal("trades"), v.literal("holders")),
    json: v.optional(v.string()), stateJson: v.optional(v.string()), observedAt: v.optional(v.number()),
    leaseId: v.string(), leaseUntil: v.number(), retryAt: v.number(),
    diagnostic: v.optional(v.string()),
  }).index("by_token_kind", ["token", "kind"]),
  websiteHolderHistory: defineTable({
    token: v.string(), throughBlock: v.string(), blockHash: v.string(), updatedAt: v.number(),
  }).index("by_token", ["token"]),
  websiteHolderBalances: defineTable({
    token: v.string(), address: v.string(), raw: v.string(), rank: v.number(),
  }).index("by_token_address", ["token", "address"]).index("by_token_rank", ["token", "rank"]),

  websiteProviderBudget: defineTable({
    key: v.string(), attempts: v.array(v.number()), blockedUntil: v.optional(v.number()),
    interactiveUntil: v.optional(v.number()), periodKey: v.optional(v.string()), periodCount: v.optional(v.number()),
    officialPeriodCount: v.optional(v.number()), officialPeriodLimit: v.optional(v.number()),
    officialRemaining: v.optional(v.number()), officialRateLimit: v.optional(v.number()),
    officialPlan: v.optional(v.string()), officialSyncedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  marketIndexState: defineTable({
    key: v.string(),
    indexedThroughBlock: v.optional(v.string()),
    leaseUntil: v.number(),
    leaseId: v.optional(v.string()),
    lastViewerAt: v.number(),
    lastRecordedAt: v.optional(v.number()),
    catalogRefreshedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  marketViewerRateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  marketPriceCache: defineTable({
    key: v.string(),
    value: v.number(),
    sourceTimestamp: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Immutable five-minute ETH/USD opening prices, shared by every fee claim.
  historicalEthPrices: defineTable({
    bucketAt: v.number(), priceUsd: v.number(), source: v.string(), fetchedAt: v.number(),
  }).index("by_bucket", ["bucketAt"]),
  creatorFeeClaims: defineTable({
    key: v.string(), transactionHash: v.string(), source: v.union(v.literal("legacy"), v.literal("vault")),
    assetSymbol: v.string(), assetAddress: v.optional(v.string()), amount: v.number(),
    rawAmount: v.optional(v.string()), blockNumber: v.optional(v.string()),
    recordedAt: v.number(), claimedAt: v.optional(v.number()),
    timestampSource: v.optional(v.union(v.literal("block"), v.literal("recorded_confirmation"))),
    status: v.union(v.literal("pending"), v.literal("priced"), v.literal("unsupported")),
    nextAttemptAt: v.number(), priceBucketAt: v.optional(v.number()), priceUsd: v.optional(v.number()),
    valueUsd: v.optional(v.number()), diagnosticCode: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_key", ["key"]).index("by_status_due", ["status", "nextAttemptAt"]),
  creatorFeeStats: defineTable({
    key: v.string(), totalUsd: v.number(), claimCount: v.number(), pricedCount: v.number(),
    amountsJson: v.string(), updatedAt: v.number(),
  }).index("by_key", ["key"]),
  creatorFeeHistoryWorker: defineTable({
    key: v.string(), legacyCursor: v.optional(v.string()), legacyDone: v.boolean(),
    vaultCursor: v.optional(v.string()), vaultDone: v.boolean(),
    leaseToken: v.optional(v.string()), leaseUntil: v.optional(v.number()),
    nextRunAt: v.number(), lastError: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_key", ["key"]),
  platformStatsCache: defineTable({
    key: v.string(),
    launches: v.number(),
    wallets: v.number(),
    volume24hUsd: v.number(),
    volumeCoverage: v.number(),
    lifetimeVolumeUsd: v.optional(v.number()),
    lifetimeVolumeCoverage: v.optional(v.number()),
    feesClaimedJson: v.string(),
    feesClaimedUsd: v.number(),
    feeValuationVersion: v.optional(v.number()),
    feeClaimsUnpriced: v.optional(v.number()),
    feeClaimTransactions: v.number(),
    marketUpdatedAt: v.number(),
    computedAt: v.number(),
  }).index("by_key", ["key"]),

  houdiniX402Payments: defineTable({
    fingerprint: v.string(),
    endpoint: v.string(),
    operation: v.union(
      v.literal("read"),
      v.literal("quote"),
      v.literal("exchange"),
      v.literal("status"),
    ),
    atomicAmount: v.number(),
    status: v.union(
      v.literal("reserved"),
      v.literal("settled"),
      v.literal("failed"),
      v.literal("uncertain"),
    ),
    payerAddress: v.optional(v.string()),
    settlementTransaction: v.optional(v.string()),
    error: v.optional(v.string()),
    spendBucketKey: v.optional(v.string()),
    sessionSpendKey: v.optional(v.string()),
    challengeId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_fingerprint", ["fingerprint"])
    .index("by_created_at", ["createdAt"])
    .index("by_status_updated_at", ["status", "updatedAt"]),

  houdiniX402SpendBuckets: defineTable({
    key: v.string(),
    hourStartedAt: v.number(),
    atomicAmount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_hour", ["hourStartedAt"]),

  houdiniX402SessionSpend: defineTable({
    key: v.string(),
    atomicAmount: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expires_at", ["expiresAt"]),

  houdiniTokenSearchCache: defineTable({
    key: v.string(),
    tokenIds: v.array(v.string()),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expires_at", ["expiresAt"]),

  houdiniTokens: defineTable({
    tokenId: v.string(),
    symbol: v.string(),
    name: v.string(),
    chain: v.string(),
    tokenAddress: v.optional(v.string()),
    icon: v.optional(v.string()),
    hasCex: v.boolean(),
    enabled: v.boolean(),
    addressValidation: v.optional(v.string()),
    memoNeeded: v.optional(v.boolean()),
    chainKind: v.optional(v.string()),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token_id", ["tokenId"])
    .index("by_expires_at", ["expiresAt"]),

  houdiniQuoteReviews: defineTable({
    reviewId: v.string(),
    sessionIdHash: v.string(),
    ownerXUserId: v.optional(v.string()),
    quoteId: v.string(),
    fromTokenId: v.string(),
    toTokenId: v.string(),
    sourceAmount: v.string(),
    sourceLabel: v.optional(v.string()),
    targetLabel: v.optional(v.string()),
    destination: v.string(),
    privateMode: v.boolean(),
    expiresAt: v.number(),
    retentionExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    status: v.optional(
      v.union(
        v.literal("quoted"),
        v.literal("submitting"),
        v.literal("awaiting_funding"),
        v.literal("funding"),
        v.literal("funded"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("uncertain"),
      ),
    ),
    executionAttemptId: v.optional(v.string()),
    houdiniId: v.optional(v.string()),
    depositAddress: v.optional(v.string()),
    fundingRequestId: v.optional(v.string()),
    fundingWalletRequestId: v.optional(v.string()),
    fundingAttempt: v.optional(v.number()),
    fundingTransactionHash: v.optional(v.string()),
    displayStatus: v.optional(v.string()),
    statusLabel: v.optional(v.string()),
    safeError: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    lastStatusCheckedAt: v.optional(v.number()),
  })
    .index("by_review_id", ["reviewId"])
    .index("by_session", ["sessionIdHash"])
    .index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_owner_updated_at", ["ownerXUserId", "updatedAt"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_retention_expires_at", ["retentionExpiresAt"]),

  xHoudiniQuotes: defineTable({
    telegramUpdateId: v.optional(v.string()),
    requestPostId: v.string(),
    deliverySource: v.optional(v.union(v.literal("x"), v.literal("telegram"))),
    telegramUserId: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    quoteResponsePostId: v.optional(v.string()),
    confirmationPostId: v.optional(v.string()),
    ownerXUserId: v.string(),
    sourceAmount: v.string(),
    sourceUnit: v.union(v.literal("eth"), v.literal("usd")),
    sourceEthAmount: v.string(),
    destination: v.string(),
    targetSymbol: v.string(),
    targetChain: v.string(),
    fromTokenId: v.string(),
    toTokenId: v.string(),
    privateMode: v.boolean(),
    confirmationRequired: v.optional(v.boolean()),
    quoteId: v.string(),
    quotedAmountOut: v.string(),
    quotedAmountOutUsd: v.optional(v.string()),
    duration: v.optional(v.string()),
    status: v.union(
      v.literal("pending_publication"),
      v.literal("awaiting_confirmation"),
      v.literal("confirmed"),
      v.literal("executing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("uncertain"),
      v.literal("monitoring_timeout"),
      v.literal("cancelled"),
      v.literal("superseded"),
    ),
    expiresAt: v.number(),
    houdiniId: v.optional(v.string()),
    depositAddress: v.optional(v.string()),
    orderExpiresAt: v.optional(v.number()),
    executionAttemptId: v.optional(v.string()),
    executionStage: v.optional(
      v.union(
        v.literal("creating_order"),
        v.literal("order_created"),
        v.literal("funding"),
        v.literal("monitoring"),
        v.literal("finished"),
      ),
    ),
    previousQuoteId: v.optional(v.id("xHoudiniQuotes")),
    fundingRequestId: v.optional(v.string()),
    fundingLeaseId: v.optional(v.string()),
    fundingLeaseUntil: v.optional(v.number()),
    nextFundingAttemptAt: v.optional(v.number()),
    fundingTransactionHash: v.optional(v.string()),
    submissionResponsePostId: v.optional(v.string()),
    submissionPublicationStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("published"),
        v.literal("uncertain"),
        v.literal("failed"),
      ),
    ),
    statusPollLeaseId: v.optional(v.string()),
    statusPollLeaseUntil: v.optional(v.number()),
    nextStatusCheckAt: v.optional(v.number()),
    statusPollAttempts: v.optional(v.number()),
    finalReplyText: v.optional(v.string()),
    finalReplyOk: v.optional(v.boolean()),
    finalPublicationStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("pending"),
        v.literal("published"),
        v.literal("uncertain"),
        v.literal("failed"),
      ),
    ),
    finalPublicationLeaseId: v.optional(v.string()),
    finalPublicationLeaseUntil: v.optional(v.number()),
    nextPublicationAttemptAt: v.optional(v.number()),
    finalPublicationAttempts: v.optional(v.number()),
    finalResponsePostId: v.optional(v.string()),
    safeError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_post", ["requestPostId"])
    .index("by_quote_response", ["quoteResponsePostId"])
    .index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_owner_updated_at", ["ownerXUserId", "updatedAt"])
    .index("by_status", ["status"])
    .index("by_stage_updated", ["executionStage", "updatedAt"])
    .index("by_stage_next_check", ["executionStage", "nextStatusCheckAt"])
    .index("by_status_next_check", ["status", "nextStatusCheckAt"])
    .index("by_final_publication_due", [
      "finalPublicationStatus",
      "nextPublicationAttemptAt",
    ]),

  xHoudiniRateLimits: defineTable({
    key: v.string(),
    utcDay: v.string(),
    dailyCount: v.number(),
    windowStartedAt: v.number(),
    windowCount: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  walletExecutionCache: defineTable({
    key: v.string(),
    kind: v.union(
      v.literal("v3_route"),
      v.literal("token_metadata"),
      v.literal("pons_pair"),
    ),
    valueJson: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  walletRateLimits: defineTable({
    ownerXUserId: v.string(),
    day: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_x_user_id", ["ownerXUserId"]),

  walletExecutionLocks: defineTable({
    walletId: v.id("cryptoWallets"),
    requestId: v.string(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.number(),
    updatedAt: v.number(),
  }).index("by_wallet_id", ["walletId"]),

  protocolContracts: defineTable({
    key: v.string(),
    address: v.string(),
    normalizedAddress: v.string(),
    active: v.boolean(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  tokenRegistry: defineTable({
    address: v.string(),
    normalizedAddress: v.string(),
    symbol: v.string(),
    name: v.string(),
    decimals: v.number(),
    pairCandidate: v.boolean(),
    pairApproved: v.boolean(),
    active: v.boolean(),
    verifiedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_normalized_address", ["normalizedAddress"])
    .index("by_symbol", ["symbol"])
    .index("by_pair_candidate", ["pairCandidate"]),

  walletTokenIndex: defineTable({
    walletId: v.id("cryptoWallets"),
    tokenAddress: v.string(),
    normalizedTokenAddress: v.string(),
    symbol: v.string(),
    involvedByLaunch: v.boolean(),
    involvedByTransaction: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_token", ["normalizedTokenAddress"])
    .index("by_wallet_token", ["walletId", "normalizedTokenAddress"]),
});
