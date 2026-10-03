import { AppError, createRequestId } from "@/server/errors";
import { hasAllowedApiHost } from "@/server/security";

import { errorResponse, json } from "../../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestId = createRequestId();
  try {
    if (!hasAllowedApiHost(request)) {
      throw new AppError({ code: "ORIGIN_FORBIDDEN", message: "API host is not allowed.", status: 403 });
    }
    return json({ status: "ok" }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
