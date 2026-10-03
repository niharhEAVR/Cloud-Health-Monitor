import { z } from "zod";

export const SERVICE_NAME_MAX_LENGTH = 100;
export const SERVICE_URL_MAX_LENGTH = 2048;
export const MIN_CHECK_INTERVAL_SECONDS = 30;
export const MAX_CHECK_INTERVAL_SECONDS = 86_400;
export const DEFAULT_CHECK_INTERVAL_SECONDS = 60;
export const MIN_HTTP_STATUS = 100;
export const MAX_HTTP_STATUS = 599;
export const DEFAULT_ACCEPTED_STATUS_MIN = 200;
export const DEFAULT_ACCEPTED_STATUS_MAX = 299;
export const MAX_SERVICES_DEFAULT = 100;

export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "MALFORMED_JSON",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "SERVICE_LIMIT_REACHED",
  "UNAVAILABLE",
  "UNSUPPORTED_MEDIA_TYPE",
  "ORIGIN_FORBIDDEN",
  "REQUEST_TOO_LARGE",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProbeErrorCodeSchema = z.enum([
  "TIMEOUT",
  "DNS_ERROR",
  "TLS_ERROR",
  "CONNECTION_ERROR",
  "TARGET_BLOCKED",
  "HTTP_STATUS",
  "PROTOCOL_ERROR",
]);
export type ProbeErrorCode = z.infer<typeof ProbeErrorCodeSchema>;

export const CheckOutcomeSchema = z.enum(["up", "down"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const DisplayStatusSchema = z.enum(["up", "down", "pending", "stale"]);
export type DisplayStatus = z.infer<typeof DisplayStatusSchema>;

export const ServiceIdSchema = z.uuid("Service ID must be a valid UUID.");

const optionalInteger = (minimum: number, maximum: number, defaultValue: number) =>
  z.number().int().min(minimum).max(maximum).default(defaultValue);

export const CreateServiceRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required.")
      .max(SERVICE_NAME_MAX_LENGTH, `Name must be at most ${SERVICE_NAME_MAX_LENGTH} characters.`),
    url: z.string().trim().min(1, "URL is required.").max(SERVICE_URL_MAX_LENGTH),
    intervalSeconds: optionalInteger(
      MIN_CHECK_INTERVAL_SECONDS,
      MAX_CHECK_INTERVAL_SECONDS,
      DEFAULT_CHECK_INTERVAL_SECONDS,
    ),
    acceptedStatusMin: optionalInteger(
      MIN_HTTP_STATUS,
      MAX_HTTP_STATUS,
      DEFAULT_ACCEPTED_STATUS_MIN,
    ),
    acceptedStatusMax: optionalInteger(
      MIN_HTTP_STATUS,
      MAX_HTTP_STATUS,
      DEFAULT_ACCEPTED_STATUS_MAX,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.acceptedStatusMin > value.acceptedStatusMax) {
      context.addIssue({
        code: "custom",
        path: ["acceptedStatusMax"],
        message: "Maximum accepted status must be greater than or equal to the minimum.",
      });
    }
  });
export type CreateServiceRequest = z.infer<typeof CreateServiceRequestSchema>;

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1, "Idempotency-Key is required.")
  .max(255, "Idempotency-Key must be at most 255 characters.");

export const HistoryRangeSchema = z.enum(["24h", "7d", "30d", "90d"]);
export type HistoryRange = z.infer<typeof HistoryRangeSchema>;

export const HistoryPageSizeSchema = z.coerce.number().int().min(1).max(100).default(50);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
