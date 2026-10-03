import { ServiceIdSchema } from "@/shared/contracts";
import { AppError, createRequestId } from "@/server/errors";
import { getServiceSummary, removeService } from "@/server/query-services";
import { hasAllowedApiHost, hasAllowedMutationOrigin } from "@/server/security";

import { empty, errorResponse, json } from "../../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function serviceId(context: RouteContext): Promise<string> {
  return ServiceIdSchema.parse((await context.params).id);
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedApiHost(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "API host is not allowed.", status: 403 });
    }
    const service = await getServiceSummary(await serviceId(context));
    if (service === null) throw new AppError({ code: "NOT_FOUND", message: "Service was not found.", status: 404 });
    return json(service, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedApiHost(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "API host is not allowed.", status: 403 });
    }
    if (!hasAllowedMutationOrigin(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "Mutations must come from this application origin.", status: 403 });
    }
    await removeService(await serviceId(context));
    return empty({ status: 204, headers: { "X-Request-Id": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
