import { HistoryPageSizeSchema, HistoryRangeSchema, ServiceIdSchema } from "@/shared/contracts";
import { AppError, createRequestId } from "@/server/errors";
import { getHistoryPage, getServiceSummary, parseHistoryCursor } from "@/server/query-services";
import { hasAllowedApiHost } from "@/server/security";

import { errorResponse, json } from "../../../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedApiHost(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "API host is not allowed.", status: 403 });
    }
    const serviceId = ServiceIdSchema.parse((await context.params).id);
    const url = new URL(request.url);
    const range = HistoryRangeSchema.parse(url.searchParams.get("range") ?? "24h");
    const pageSize = HistoryPageSizeSchema.parse(url.searchParams.get("pageSize") ?? url.searchParams.get("limit") ?? undefined);
    const cursorValue = url.searchParams.get("cursor");
    const cursor = cursorValue === null ? undefined : parseHistoryCursor(cursorValue, serviceId, range);
    const history = await getHistoryPage({ serviceId, range, pageSize, ...(cursor === undefined ? {} : { cursor }) });
    if (history === null) throw new AppError({ code: "NOT_FOUND", message: "Service was not found.", status: 404 });
    const service = await getServiceSummary(serviceId, new Date(history.asOf));
    if (service === null) throw new AppError({ code: "NOT_FOUND", message: "Service was not found.", status: 404 });
    const completedChecks = history.buckets.reduce((total, bucket) => total + bucket.completedChecks, 0);
    const acceptedChecks = history.buckets.reduce((total, bucket) => total + bucket.acceptedChecks, 0);
    return json(
      { service, range, availability: completedChecks === 0 ? null : acceptedChecks / completedChecks, ...history },
      { headers: { "X-Request-Id": requestId } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
