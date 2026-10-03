import { CreateServiceRequestSchema, IdempotencyKeySchema } from "@/shared/contracts";
import { normalizeServiceUrl, UrlValidationError } from "@/shared/url";
import { createService, getServiceSummaries, getWorkerSummary } from "@/server/query-services";
import { AppError, createRequestId, validationError } from "@/server/errors";
import { parseServerEnv } from "@/server/env";
import { hasAllowedMutationOrigin, isJsonRequest } from "@/server/security";

import { errorResponse, json, readJson } from "../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = createRequestId();
  try {
    const now = new Date();
    const [services, worker] = await Promise.all([getServiceSummaries(now), getWorkerSummary(now)]);
    const fleet = { up: 0, down: 0, pending: 0, stale: 0 };
    for (const service of services) fleet[service.status] += 1;
    return json(
      {
        serverTime: now.toISOString(),
        worker: { ...worker, delayed: !worker.isFresh, lastHeartbeatAt: worker.lastSeenAt },
        counts: fleet,
        fleet,
        services,
      },
      { headers: { "X-Request-Id": requestId } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedMutationOrigin(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "Mutations must come from this application origin.", status: 403 });
    }
    if (!isJsonRequest(request)) {
      throw new AppError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json.", status: 415 });
    }
    const idempotencyKey = IdempotencyKeySchema.parse(request.headers.get("idempotency-key"));
    const body = CreateServiceRequestSchema.parse(await readJson(request));
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeServiceUrl(body.url);
    } catch (error) {
      if (error instanceof UrlValidationError) throw validationError("Request validation failed.", { url: [error.message] });
      throw error;
    }
    const result = await createService({
      name: body.name,
      normalizedUrl,
      intervalSeconds: body.intervalSeconds,
      acceptedStatusMin: body.acceptedStatusMin,
      acceptedStatusMax: body.acceptedStatusMax,
      idempotencyKey,
      maxServices: parseServerEnv().MAX_SERVICES,
    });
    return json(
      result.service,
      {
        status: result.created ? 201 : 200,
        headers: { Location: `/api/services/${result.service.id}`, "X-Request-Id": requestId },
      },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
