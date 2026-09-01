/** Only throw before a payment-authorized request has been attempted. */
export class HoudiniPrePaymentError extends Error {
  readonly code = "houdini_pre_payment_rejected";
}

export function validateHoudiniPaymentResource(resource: unknown, requested: URL): void {
  const origin = "https://api-partner.houdiniswap.com";
  const reject = () => { throw new HoudiniPrePaymentError("Houdini returned mismatched x402 resource terms"); };
  if (typeof resource !== "string" || !resource.trim()) return reject();
  let advertised: URL;
  try { advertised = new URL(resource, origin); } catch { return reject(); }
  if (requested.origin !== origin || requested.username || requested.password || requested.hash ||
      !requested.pathname.startsWith("/v2/") ||
      !["http:", "https:"].includes(advertised.protocol) ||
      advertised.hostname !== "api-partner.houdiniswap.com" || advertised.port ||
      advertised.username || advertised.password || advertised.hash) return reject();
  // Houdini's reverse proxy sometimes advertises HTTP. Never use that URL for
  // transport: allow only its scheme to differ from our pinned HTTPS request.
  advertised.protocol = "https:";
  const expected = new URL(requested);
  advertised.searchParams.sort();
  expected.searchParams.sort();
  if (advertised.href !== expected.href) return reject();
}

export function houdiniSubmissionFailureOutcome(error: unknown): "failed" | "uncertain" {
  return error instanceof HoudiniPrePaymentError ? "failed" : "uncertain";
}
