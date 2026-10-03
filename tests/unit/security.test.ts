import { describe, expect, it } from "vitest";

import { applySecurityHeaders, hasAllowedApiHost, hasAllowedMutationOrigin, isJsonRequest } from "@/server/security";

describe("mutation request safeguards", () => {
  const origin = "https://monitor.example.com";

  it("accepts same-origin JSON writes and rejects cross-origin writes", () => {
    const sameOrigin = new Request(origin, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    });
    const otherOrigin = new Request(origin, { method: "POST", headers: { origin: "https://attacker.example" } });

    expect(hasAllowedMutationOrigin(sameOrigin, origin)).toBe(true);
    expect(isJsonRequest(sameOrigin)).toBe(true);
    expect(hasAllowedMutationOrigin(otherOrigin, origin)).toBe(false);
  });

  it("accepts only the configured Host header for API routes", () => {
    expect(hasAllowedApiHost(new Request(origin, { headers: { host: "monitor.example.com" } }), origin)).toBe(true);
    expect(hasAllowedApiHost(new Request(origin, { headers: { host: "attacker.example" } }), origin)).toBe(false);
    expect(hasAllowedApiHost(new Request(origin), origin)).toBe(false);
  });

  it("adds browser response protections", () => {
    const headers = applySecurityHeaders(new Headers());
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });
});
