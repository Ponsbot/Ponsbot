import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";
import process from "node:process";

const TARGET_USERNAME = process.env.X_BOT_USERNAME?.replace(/^@/, "") || "Ponsbot";
const REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
const ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";
const OUTPUT_FILE = ".env.x-oauth";

function readEnvFile(filename) {
  if (!fs.existsSync(filename)) return {};
  return Object.fromEntries(fs.readFileSync(filename, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauthHeader(url, consumerKey, consumerSecret, token, tokenSecret = "", extra = {}) {
  const parameters = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(24).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token } : {}),
    ...extra,
  };
  const parameterString = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const base = `POST&${encode(url)}&${encode(parameterString)}`;
  const key = `${encode(consumerSecret)}&${encode(tokenSecret)}`;
  parameters.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return `OAuth ${Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encode(name)}="${encode(value)}"`)
    .join(", ")}`;
}

async function tokenRequest(url, consumerKey, consumerSecret, token, tokenSecret, extra) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: oauthHeader(url, consumerKey, consumerSecret, token, tokenSecret, extra) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`X ${response.status}: ${body}`);
  return Object.fromEntries(new URLSearchParams(body));
}

const local = readEnvFile(".env.local");
const consumerKey = process.env.X_API_KEY || local.X_API_KEY;
const consumerSecret = process.env.X_API_SECRET || local.X_API_SECRET;
if (!consumerKey || !consumerSecret) {
  console.error("Add the Ponsbot app's X_API_KEY and X_API_SECRET to .env.local first.");
  process.exit(1);
}

const request = await tokenRequest(
  REQUEST_TOKEN_URL,
  consumerKey,
  consumerSecret,
  undefined,
  "",
  { oauth_callback: "oob" },
);
if (!request.oauth_token || !request.oauth_token_secret) {
  throw new Error("X did not return a request token.");
}

const authorizeUrl = new URL("https://api.x.com/oauth/authorize");
authorizeUrl.searchParams.set("oauth_token", request.oauth_token);
authorizeUrl.searchParams.set("force_login", "true");
authorizeUrl.searchParams.set("screen_name", TARGET_USERNAME);

console.log(`\nOpen this URL and sign in specifically as @${TARGET_USERNAME}:\n`);
console.log(authorizeUrl.toString());
console.log("\nApprove the Ponsbot app, then copy the PIN shown by X.\n");

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
const verifier = (await terminal.question("X authorization PIN: ")).trim();
terminal.close();
if (!/^\d{4,12}$/.test(verifier)) throw new Error("The X authorization PIN is invalid.");

const access = await tokenRequest(
  ACCESS_TOKEN_URL,
  consumerKey,
  consumerSecret,
  request.oauth_token,
  request.oauth_token_secret,
  { oauth_verifier: verifier },
);
if (!access.oauth_token || !access.oauth_token_secret) {
  throw new Error("X did not return user access credentials.");
}
if ((access.screen_name || "").toLowerCase() !== TARGET_USERNAME) {
  throw new Error(`Authorization belongs to @${access.screen_name || "unknown"}, not @${TARGET_USERNAME}. Nothing was saved.`);
}

fs.writeFileSync(OUTPUT_FILE, [
  `X_API_KEY=${consumerKey}`,
  `X_API_SECRET=${consumerSecret}`,
  `X_ACCESS_TOKEN=${access.oauth_token}`,
  `X_ACCESS_TOKEN_SECRET=${access.oauth_token_secret}`,
  "",
].join("\n"), { encoding: "utf8", mode: 0o600 });

console.log(`\nAuthorized @${access.screen_name}. Credentials were saved to ${OUTPUT_FILE}.`);
console.log("This file is excluded by .gitignore. Do not commit or share it.");
