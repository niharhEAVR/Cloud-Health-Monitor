import { createRequestId } from "@/server/errors";

import { json } from "../../_lib/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const requestId = createRequestId();
  return json({ status: "ok" }, { headers: { "X-Request-Id": requestId } });
}
