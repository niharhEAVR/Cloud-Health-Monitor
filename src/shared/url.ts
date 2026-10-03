import { SERVICE_URL_MAX_LENGTH } from "@/shared/contracts";

export class UrlValidationError extends Error {
  readonly code = "INVALID_URL";

  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

/**
 * Produces the canonical URL used for storage and duplicate detection. This is
 * intentionally separate from network safety checks, which occur after DNS
 * resolution in the worker before every probe.
 */
export function normalizeServiceUrl(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new UrlValidationError("URL is required.");
  }
  if (candidate.length > SERVICE_URL_MAX_LENGTH) {
    throw new UrlValidationError(`URL must be at most ${SERVICE_URL_MAX_LENGTH} characters.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UrlValidationError("URL must be an absolute HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlValidationError("Only HTTP and HTTPS URLs are supported.");
  }
  if (!parsed.hostname) {
    throw new UrlValidationError("URL must include a host.");
  }
  if (parsed.username || parsed.password) {
    throw new UrlValidationError("URLs with embedded credentials are not supported.");
  }
  if (parsed.hash) {
    throw new UrlValidationError("URL fragments are not sent to servers and are not supported.");
  }

  // URL serialisation lowercases the host and removes default ports. Keeping
  // query strings preserves endpoint identity while logs redact them separately.
  return parsed.toString();
}
