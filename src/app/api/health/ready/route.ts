import { getPool, queryOne } from "@/server/db";
import { AppError, createRequestId } from "@/server/errors";
import { hasAllowedApiHost } from "@/server/security";

import { errorResponse, json } from "../../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedApiHost(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "API host is not allowed.", status: 403 });
    }
    const row = await queryOne<{ schema_ready: boolean }>(
      getPool(),
      `
        SELECT to_regclass('public.services') IS NOT NULL
          AND to_regclass('public.health_checks') IS NOT NULL
          AND to_regclass('public.pgmigrations') IS NOT NULL AS schema_ready
      `,
    );
    if (row?.schema_ready !== true) {
      throw new AppError({ code: "UNAVAILABLE", message: "Database migrations are not ready.", status: 503 });
    }
    const migration = await queryOne<{ applied: boolean }>(
      getPool(),
      `SELECT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '001_initial_schema') AS applied`,
    );
    if (migration?.applied !== true) {
      throw new AppError({ code: "UNAVAILABLE", message: "Database migrations are not ready.", status: 503 });
    }
    return json({ status: "ok" }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error, requestId);
    return errorResponse(new AppError({ code: "UNAVAILABLE", message: "Database is unavailable.", status: 503 }), requestId);
  }
}
