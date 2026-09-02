import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// X jobs exit before contacting X unless replies are explicitly enabled.
crons.interval("poll direct X mentions", { minutes: 1 }, internal.xReplies.pollMentions);
crons.interval("recover queued X publications", { minutes: 1 }, internal.xReplyQueue.kick);
crons.interval("recover interrupted X interactions", { minutes: 5 }, internal.xReplies.recoverStaleInteractions);
crons.interval("monitor recent token graduations", { minutes: 1 }, internal.graduationAnnouncements.monitorGraduations);
crons.interval("maintain registry migrations", { hours: 1 }, internal.registry.ensureInitialized);
crons.interval("refresh public platform statistics", { hours: 1 }, internal.site.refreshPlatformStatsCache);
crons.interval("value creator fees at historical ETH prices", { hours: 1 }, internal.creatorFeeHistory.refresh);
crons.interval("refresh lifetime trading volume", { hours: 3 }, internal.lifetimeVolume.requestRefresh);
crons.interval("clean market viewer rate limits", { hours: 1 }, internal.site.cleanupMarketViewerRateLimits);
crons.interval("clean expired website market cache", { hours: 1 }, internal.marketData.cleanup);
crons.interval("reconcile CoinGecko account usage", { hours: 6 }, internal.marketData.syncCoinGeckoUsage);
crons.interval("reconcile interrupted Houdini x402 audits", { minutes: 5 }, internal.site.reconcileStaleHoudiniX402Payments);
crons.interval("reconcile interrupted X Houdini swaps", { minutes: 1 }, internal.xHoudini.reconcileInterrupted);
crons.interval("reconcile free launch sponsorships", { minutes: 1 }, internal.wallets.reconcileFreeLaunchSponsorships);
// The action exits without reading or writing state unless the unreleased
// automated fee engine is explicitly enabled and fully configured.
// Wake/recover the durable queue each minute; each token retains a fixed 15m cadence.
crons.interval("process automated creator fees", { minutes: 1 }, internal.automatedFeeEngine.runScheduledProcessing);
crons.interval("recover automated fee enrollments", { minutes: 1 }, internal.automatedFeeEngine.recoverPreparedEnrollments);
crons.interval("recover automated fee controller changes", { minutes: 1 }, internal.automatedFeeEngine.recoverControllerChanges);
crons.interval("monitor automated fee health", { minutes: 5 }, internal.automatedFeeEngine.monitorOperationalHealth);
crons.interval("expire automated fee enrollment reservations", { hours: 1 }, internal.automatedFeeEngine.expirePrelaunchEnrollments);

crons.interval("recover liquidity executions", { minutes: 1 }, internal.liquidity.recoverExecutions);
crons.interval("monitor liquidity health", { minutes: 5 }, internal.liquidity.monitorHealth);

export default crons;
