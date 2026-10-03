/** Convert dates to API-safe ISO strings without mutating the source object. */
export function toIsoString(value: Date): string {
  return value.toISOString();
}

/** A bounded, stable request hash input for create-idempotency records. */
export function canonicalCreateRequest(input: {
  name: string;
  normalizedUrl: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
}): string {
  return JSON.stringify({
    acceptedStatusMax: input.acceptedStatusMax,
    acceptedStatusMin: input.acceptedStatusMin,
    intervalSeconds: input.intervalSeconds,
    name: input.name,
    normalizedUrl: input.normalizedUrl,
  });
}
