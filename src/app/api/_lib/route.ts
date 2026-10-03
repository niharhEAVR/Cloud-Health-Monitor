import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AppError, createRequestId, toApiError, validationError } from "@/server/errors";
import { applySecurityHeaders } from "@/server/security";

export const runtime = "nodejs";

export function json(body: unknown, init: ResponseInit = {}): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  applySecurityHeaders(response.headers);
  return response;
}

export function empty(init: ResponseInit = {}): NextResponse {
  const response = new NextResponse(null, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  applySecurityHeaders(response.headers);
  return response;
}

export function errorResponse(error: unknown, requestId = createRequestId()): NextResponse {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const field = issue.path.join(".") || "request";
      (fieldErrors[field] ??= []).push(issue.message);
    }
    error = validationError("Request validation failed.", fieldErrors);
  }
  if (error instanceof AppError) {
    return json(toApiError(error, requestId), { status: error.status });
  }
  const databaseCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (["08000", "08001", "08003", "08006", "55P03", "57014", "57P01", "53300", "ECONNREFUSED", "ETIMEDOUT"].includes(databaseCode ?? "")) {
    return json(
      { error: { code: "UNAVAILABLE", message: "A required dependency is unavailable.", requestId } },
      { status: 503 },
    );
  }
  console.error("Unhandled API error", { requestId, error: error instanceof Error ? error.message : "unknown" });
  return json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", requestId } }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const maximumBytes = 64 * 1024;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new AppError({ code: "REQUEST_TOO_LARGE", message: "Request body is too large.", status: 413 });
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new AppError({ code: "MALFORMED_JSON", message: "Request body must contain valid JSON.", status: 400 });
  }
  try {
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new AppError({ code: "REQUEST_TOO_LARGE", message: "Request body is too large.", status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({ code: "MALFORMED_JSON", message: "Request body must contain valid JSON.", status: 400 });
  }
}
