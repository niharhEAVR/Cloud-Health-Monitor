import type { ApiError, ErrorCode } from "@/shared/contracts";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(options: {
    code: ErrorCode;
    message: string;
    status: number;
    fieldErrors?: Record<string, string[]>;
  }) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status;
    this.fieldErrors = options.fieldErrors;
  }
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function toApiError(error: AppError, requestId: string): ApiError {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }),
      requestId,
    },
  };
}

export function validationError(
  message: string,
  fieldErrors?: Record<string, string[]>,
): AppError {
  return new AppError({
    code: "VALIDATION_ERROR",
    message,
    status: 422,
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
  });
}
