import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// X jobs exit before contacting X unless replies are explicitly enabled.
crons.interval("poll direct X mentions", { minutes: 1 }, internal.xReplies.pollMentions);
crons.interval("monitor recent token graduations", { minutes: 1 }, internal.graduationAnnouncements.monitorGraduations);
crons.interval("maintain registry migrations", { hours: 1 }, internal.registry.ensureInitialized);
crons.interval("clean market viewer rate limits", { hours: 1 }, internal.site.cleanupMarketViewerRateLimits);

export default crons;
