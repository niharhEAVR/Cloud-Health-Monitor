import { describe, expect, it } from "vitest";

import { UrlValidationError, normalizeServiceUrl } from "@/shared/url";

describe("normalizeServiceUrl", () => {
  it("canonicalizes host casing and default ports", () => {
    expect(normalizeServiceUrl(" HTTPS://Example.COM:443/status?full=true ")).toBe(
      "https://example.com/status?full=true",
    );
  });

  it.each([
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com/#section",
    "not a url",
  ])("rejects unsupported or unsafe input: %s", (value) => {
    expect(() => normalizeServiceUrl(value)).toThrow(UrlValidationError);
  });
});
