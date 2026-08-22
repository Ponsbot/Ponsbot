import { NextRequest, NextResponse } from "next/server";

function compact(parts: string[]) {
  return parts.join("; ");
}

function policy(request: NextRequest, nonce?: string) {
  const development = process.env.NODE_ENV !== "production";
  const strictScripts = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`
    : `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`;
  return compact([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    strictScripts,
    // Retain inline styles for the small first-paint stylesheet in RootLayout.
    // Script execution is nonce protected on wallet-sensitive routes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " http: https: ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
  ]);
}

function isSensitivePage(pathname: string) {
  return pathname === "/terminal" || pathname.startsWith("/wallet/") || pathname.startsWith("/launch/");
}

export function middleware(request: NextRequest) {
  const nonce = isSensitivePage(request.nextUrl.pathname)
    ? Buffer.from(crypto.randomUUID()).toString("base64")
    : undefined;
  const csp = policy(request, nonce);
  const requestHeaders = new Headers(request.headers);
  if (nonce) requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const reportOnly = process.env.CSP_REPORT_ONLY === "true";
  response.headers.set(reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{
    source: "/((?!api|_next/static|_next/image|favicon.ico|favicon.png|faviconlarge.png|ponsbot.png|ponsbot-banner.png|x-logo.png|x.webp).*)",
    missing: [
      { type: "header", key: "next-router-prefetch" },
      { type: "header", key: "purpose", value: "prefetch" },
    ],
  }],
};
