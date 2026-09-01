import crypto from "node:crypto";
import fs from "node:fs";

function readEnv(filename) {
  if (!fs.existsSync(filename)) return {};
  return Object.fromEntries(fs.readFileSync(filename, "utf8").split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#") && line.includes("="))
    .map((line) => { const at = line.indexOf("="); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function authorization(url, credentials, method = "GET") {
  const oauth = {
    oauth_consumer_key: credentials.key,
    oauth_nonce: crypto.randomBytes(24).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
    oauth_token: credentials.token,
    oauth_version: "1.0",
  };
  const parsed = new URL(url);
  const signatureParameters = [...Object.entries(oauth), ...parsed.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const parameterString = signatureParameters.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const base = `${method}&${encode(`${parsed.origin}${parsed.pathname}`)}&${encode(parameterString)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", `${encode(credentials.secret)}&${encode(credentials.tokenSecret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries(oauth).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(", ")}`;
}

const env = { ...readEnv(".env.local"), ...readEnv(".env.x-oauth"), ...process.env };
const credentials = { key: env.X_API_KEY, secret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_TOKEN_SECRET };
if (!env.X_BOT_USER_ID || Object.values(credentials).some((value) => !value)) throw new Error("X bot ID or OAuth credentials are missing");

const postReplyArgument = process.argv.find((argument) => argument.startsWith("--post-reply-to="));
if (postReplyArgument) {
  const sourcePostId = postReplyArgument.slice("--post-reply-to=".length);
  const textArgument = process.argv.find((argument) => argument.startsWith("--text="));
  const text = textArgument?.slice("--text=".length) || "";
  if (!/^\d{1,30}$/.test(sourcePostId)) throw new Error("Invalid source post ID");
  if (!text.trim()) throw new Error("Reply text is empty");
  const url = "https://api.x.com/2/tweets";
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: authorization(url, credentials, "POST"), "content-type": "application/json" },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: sourcePostId } }),
  });
  const payload = await response.json();
  console.log(JSON.stringify({ status: response.status, sourcePostId, payload }, null, 2));
  if (!response.ok) process.exitCode = 1;
  process.exit();
}

const replyLatestArgument = process.argv.find((argument) => argument.startsWith("--reply-latest="));
if (replyLatestArgument) {
  const username = replyLatestArgument.slice("--reply-latest=".length).replace(/^@/, "");
  const textArgument = process.argv.find((argument) => argument.startsWith("--text="));
  const text = textArgument?.slice("--text=".length) || "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error("Invalid X username");
  if (!text.trim()) throw new Error("Reply text is empty");
  const userUrl = `https://api.x.com/2/users/by/username/${username}`;
  const userResponse = await fetch(userUrl, { headers: { authorization: authorization(userUrl, credentials) } });
  const userPayload = await userResponse.json();
  if (!userResponse.ok || !userPayload.data?.id) throw new Error(`X user lookup failed with status ${userResponse.status}`);
  const timelineQuery = new URLSearchParams({ max_results: "5", exclude: "retweets", "tweet.fields": "created_at,referenced_tweets,text" });
  const timelineUrl = `https://api.x.com/2/users/${userPayload.data.id}/tweets?${timelineQuery}`;
  const timelineResponse = await fetch(timelineUrl, { headers: { authorization: authorization(timelineUrl, credentials) } });
  const timelinePayload = await timelineResponse.json();
  if (!timelineResponse.ok) throw new Error(`X timeline lookup failed with status ${timelineResponse.status}`);
  const latest = (timelinePayload.data || []).find((post) => !post.referenced_tweets?.some((reference) => reference.type === "replied_to"));
  if (!latest) throw new Error("No recent original post was found");
  const postUrl = "https://api.x.com/2/tweets";
  const response = await fetch(postUrl, {
    method: "POST",
    headers: { authorization: authorization(postUrl, credentials, "POST"), "content-type": "application/json" },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: latest.id } }),
  });
  const payload = await response.json();
  console.log(JSON.stringify({ status: response.status, source: latest, payload }, null, 2));
  if (!response.ok) process.exitCode = 1;
  process.exit();
}

const auditArgument = process.argv.find((argument) => argument.startsWith("--audit-minutes="));
if (auditArgument) {
  const minutes = Number(auditArgument.slice("--audit-minutes=".length));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error("Audit minutes must be between 1 and 60");
  const startTime = new Date(Date.now() - minutes * 60_000).toISOString();
  const fields = "created_at,author_id,conversation_id,referenced_tweets";
  const mentionQuery = new URLSearchParams({ max_results: "100", start_time: startTime, "tweet.fields": fields, expansions: "author_id", "user.fields": "username" });
  const postQuery = new URLSearchParams({ max_results: "100", start_time: startTime, "tweet.fields": fields });
  const mentionUrl = `https://api.x.com/2/users/${env.X_BOT_USER_ID}/mentions?${mentionQuery}`;
  const postUrl = `https://api.x.com/2/users/${env.X_BOT_USER_ID}/tweets?${postQuery}`;
  const [mentionResponse, postResponse] = await Promise.all([
    fetch(mentionUrl, { headers: { authorization: authorization(mentionUrl, credentials) } }),
    fetch(postUrl, { headers: { authorization: authorization(postUrl, credentials) } }),
  ]);
  const [mentionPayload, postPayload] = await Promise.all([mentionResponse.json(), postResponse.json()]);
  if (!mentionResponse.ok) throw new Error(`X mention audit failed with status ${mentionResponse.status}`);
  if (!postResponse.ok) throw new Error(`X post audit failed with status ${postResponse.status}`);
  const usernames = new Map((mentionPayload.includes?.users || []).map((user) => [user.id, user.username]));
  console.log(JSON.stringify({
    startTime,
    mentions: (mentionPayload.data || []).map((post) => ({ id: post.id, username: usernames.get(post.author_id), text: post.text, createdAt: post.created_at })),
    botPosts: (postPayload.data || []).map((post) => ({ id: post.id, text: post.text, createdAt: post.created_at, referencedTweets: post.referenced_tweets })),
  }, null, 2));
  process.exit(0);
}

const inspectUserArgument = process.argv.find((argument) => argument.startsWith("--inspect-user-id="));
if (inspectUserArgument) {
  const userId = inspectUserArgument.slice("--inspect-user-id=".length);
  if (!/^\d{1,30}$/.test(userId)) throw new Error("Invalid X user ID");
  const query = new URLSearchParams({
    max_results: "20",
    "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets,text",
  });
  const url = `https://api.x.com/2/users/${userId}/tweets?${query}`;
  const response = await fetch(url, { headers: { authorization: authorization(url, credentials) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`X user timeline lookup failed with status ${response.status}`);
  console.log(JSON.stringify({
    status: response.status,
    rateLimit: {
      limit: response.headers.get("x-rate-limit-limit"),
      remaining: response.headers.get("x-rate-limit-remaining"),
      reset: response.headers.get("x-rate-limit-reset"),
    },
    posts: payload.data || [],
  }, null, 2));
  process.exit(0);
}

const postArgument = process.argv.find((argument) => argument.startsWith("--post="));
if (postArgument) {
  const text = postArgument.slice("--post=".length);
  if (!text.trim()) throw new Error("Standalone post text is empty");
  const url = "https://api.x.com/2/tweets";
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: authorization(url, credentials, "POST"), "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const payload = await response.json();
  console.log(JSON.stringify({ status: response.status, rateLimit: response.headers.get("x-rate-limit-limit"), remaining: response.headers.get("x-rate-limit-remaining"), reset: response.headers.get("x-rate-limit-reset"), payload }, null, 2));
  if (!response.ok) process.exitCode = 1;
  process.exit();
}

const findArgument = process.argv.find((argument) => argument.startsWith("--find="));
if (findArgument) {
  const needle = findArgument.slice("--find=".length).toLowerCase();
  const query = new URLSearchParams({
    max_results: "100",
    "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,verified,verified_type,subscription_type",
  });
  const url = `https://api.x.com/2/users/${env.X_BOT_USER_ID}/mentions?${query}`;
  const response = await fetch(url, { headers: { authorization: authorization(url, credentials) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`X mention lookup failed with status ${response.status}`);
  const users = new Map((payload.includes?.users || []).map((user) => [user.id, user]));
  console.log(JSON.stringify((payload.data || []).filter((post) => post.text?.toLowerCase().includes(needle)).map((post) => ({
    id: post.id,
    authorId: post.author_id,
    username: users.get(post.author_id)?.username,
    verified: users.get(post.author_id)?.verified,
    verifiedType: users.get(post.author_id)?.verified_type,
    subscriptionType: users.get(post.author_id)?.subscription_type,
    text: post.text,
    createdAt: post.created_at,
    conversationId: post.conversation_id,
    referencedTweets: post.referenced_tweets,
  })), null, 2));
  process.exit(0);
}

const replyToArgument = process.argv.find((argument) => argument.startsWith("--reply-to="));
if (replyToArgument) {
  const sourcePostId = replyToArgument.slice("--reply-to=".length);
  const query = new URLSearchParams({ max_results: "100", "tweet.fields": "created_at,conversation_id,referenced_tweets" });
  const url = `https://api.x.com/2/users/${env.X_BOT_USER_ID}/tweets?${query}`;
  const response = await fetch(url, { headers: { authorization: authorization(url, credentials) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`X reply lookup failed with status ${response.status}`);
  console.log(JSON.stringify((payload.data || []).filter((post) => post.referenced_tweets?.some((reference) => reference.type === "replied_to" && reference.id === sourcePostId)), null, 2));
  process.exit(0);
}

const day = new Date().toISOString().slice(0, 10);
let paginationToken;
let postsToday = 0;
let pages = 0;
const timestampsToday = [];
do {
  const query = new URLSearchParams({ max_results: "100", "tweet.fields": "created_at" });
  if (paginationToken) query.set("pagination_token", paginationToken);
  const url = `https://api.x.com/2/users/${env.X_BOT_USER_ID}/tweets?${query}`;
  const response = await fetch(url, { headers: { authorization: authorization(url, credentials) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`X usage lookup failed with status ${response.status}`);
  pages += 1;
  const posts = payload.data || [];
  const today = posts.filter((post) => post.created_at?.startsWith(day));
  postsToday += today.length;
  timestampsToday.push(...today.map((post) => Date.parse(post.created_at)).filter(Number.isFinite));
  if (!posts.length || posts.some((post) => post.created_at && !post.created_at.startsWith(day))) break;
  paginationToken = payload.meta?.next_token;
} while (paginationToken && pages < 10);

timestampsToday.sort((left, right) => left - right);
let peakPostsIn15Minutes = 0;
for (let left = 0, right = 0; right < timestampsToday.length; right += 1) {
  while (timestampsToday[right] - timestampsToday[left] >= 15 * 60_000) left += 1;
  peakPostsIn15Minutes = Math.max(peakPostsIn15Minutes, right - left + 1);
}
console.log(JSON.stringify({ utcDay: day, postsToday, peakPostsIn15Minutes, pagesRead: pages }, null, 2));
