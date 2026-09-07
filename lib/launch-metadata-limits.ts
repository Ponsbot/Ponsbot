// PonsV2LaunchDeployer limits UTF-8 bytes, not JavaScript string length.
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export const LAUNCH_METADATA_BYTE_MESSAGE = "⚠️ The special characters in the name or ticker exceed Pons's onchain byte limit. Shorten the name or ticker, then reply with the launch request again.";
export function launchIdentityTooLong(name: string, symbol: string) {
  return utf8Bytes(name) > 64 || utf8Bytes(symbol) > 16;
}
