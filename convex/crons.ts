import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The only scheduled job retained: checking direct X mentions for wallet or
// launch requests. It exits before contacting X unless explicitly enabled.
crons.interval("poll direct X mentions", { minutes: 1 }, internal.xReplies.pollMentions);
crons.interval("maintain registry migrations", { hours: 1 }, internal.registry.ensureInitialized);
crons.interval("clean market viewer rate limits", { hours: 1 }, internal.site.cleanupMarketViewerRateLimits);

export default crons;
