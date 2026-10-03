import "server-only";

import { parseServerEnv } from "@/server/env";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
};

export function applySecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

export function hasAllowedMutationOrigin(request: Request, appOrigin = parseServerEnv().APP_ORIGIN): boolean {
  const origin = request.headers.get("origin");
  if (origin !== appOrigin) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin" || fetchSite === "none";
}

export function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType?.toLowerCase().startsWith("application/json") ?? false;
}
