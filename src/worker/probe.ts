import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import type { IncomingMessage } from "node:http";

import { validatePublicAddresses } from "./address.js";

export type ProbeErrorCode =
  | "TIMEOUT"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "CONNECTION_ERROR"
  | "TARGET_BLOCKED"
  | "PROTOCOL_ERROR";

export type ProbeResult =
  | { ok: true; httpStatus: number; responseTimeMs: number; totalDurationMs: number }
  | { ok: false; errorCode: ProbeErrorCode; totalDurationMs: number };

export interface AddressResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface ProbeDependencies {
  resolver?: AddressResolver;
  request?: typeof httpRequest;
  /** Monotonic millisecond clock; inject only for deterministic tests. */
  now?: () => number;
  signal?: AbortSignal;
}

const defaultResolver: AddressResolver = { resolve4, resolve6 };
const maxHeaderBytes = 16 * 1024;
const timeoutError = Object.assign(new Error("Probe deadline exceeded."), { code: "ETIMEDOUT" });

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function hostnameForConnection(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function createPinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: { all?: boolean | undefined },
    callback: (error: Error | null, address: string | Array<{ address: string; family: 4 | 6 }>, family?: 4 | 6) => void,
  ): void => {
    // Node 24 can request `all: true` for connection racing. Return only the
    // validated pinned address in either callback shape.
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function withDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    return Promise.reject(timeoutError);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError), remainingMs);
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function resolveFamily(
  resolve: (hostname: string) => Promise<string[]>,
  hostname: string,
): Promise<string[]> {
  try {
    return await resolve(hostname);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENODATA") {
      return [];
    }
    throw error;
  }
}

async function resolveTarget(
  hostname: string,
  resolver: AddressResolver,
  deadlineAt: number,
  now: () => number,
): Promise<{ address: string; family: 4 | 6 }> {
  const literalHostname = hostnameForConnection(hostname);
  const literalFamily = isIP(literalHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!validatePublicAddresses([literalHostname])) {
      throw new TargetBlockedError();
    }
    return { address: literalHostname, family: literalFamily };
  }

  let addresses: [string[], string[]];
  try {
    addresses = await withDeadline(
      Promise.all([
        resolveFamily(resolver.resolve4.bind(resolver), literalHostname),
        resolveFamily(resolver.resolve6.bind(resolver), literalHostname),
      ]),
      deadlineAt - now(),
    );
  } catch (error) {
    if (error === timeoutError) {
      throw error;
    }
    throw new DnsError();
  }
  const allAddresses = [...addresses[0], ...addresses[1]];
  if (!validatePublicAddresses(allAddresses)) {
    throw new TargetBlockedError();
  }
  const address = allAddresses[0]!;
  return { address, family: isIP(address) as 4 | 6 };
}

class TargetBlockedError extends Error {
  constructor() {
    super("Target address is not public.");
  }
}

class DnsError extends Error {
  constructor() {
    super("DNS lookup failed.");
  }
}

function classifyError(error: unknown): ProbeErrorCode {
  if (error instanceof TargetBlockedError) {
    return "TARGET_BLOCKED";
  }
  if (error instanceof DnsError) {
    return "DNS_ERROR";
  }
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ETIMEDOUT" || code === "ABORT_ERR") {
    return "TIMEOUT";
  }
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "TLS_ERROR";
  }
  if (code.startsWith("HPE_")) {
    return "PROTOCOL_ERROR";
  }
  return "CONNECTION_ERROR";
}

function chooseRequest(protocol: string, injected?: typeof httpRequest): typeof httpRequest {
  if (injected) {
    return injected;
  }
  return protocol === "https:" ? httpsRequest : httpRequest;
}

function makeRequest(
  request: typeof httpRequest,
  target: URL,
  address: string,
  family: 4 | 6,
  deadlineAt: number,
  startedAt: number,
  now: () => number,
  signal: AbortSignal | undefined,
): Promise<{ statusCode: number; responseTimeMs: number }> {
  return new Promise((resolve, reject) => {
    const hostname = hostnameForConnection(target.hostname);
    const options: HttpRequestOptions & { servername?: string; rejectUnauthorized?: boolean } = {
      protocol: target.protocol,
      hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      agent: false,
      maxHeaderSize: maxHeaderBytes,
      headers: {
        Accept: "*/*",
        "User-Agent": "cloud-health-monitor/1.0",
      },
      lookup: createPinnedLookup(address, family) as HttpRequestOptions["lookup"],
      // SNI is meaningful only for a DNS name. Node rejects an IP SNI value,
      // while certificate verification remains enabled for literal targets.
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      rejectUnauthorized: true,
    };
    let settled = false;
    let timer: NodeJS.Timeout | undefined = undefined;
    const abort = () => {
      requestObject.destroy(Object.assign(new Error("Probe aborted."), { code: "ABORT_ERR" }));
    };
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      }
    };
    const requestObject = request(options as HttpRequestOptions, (response: IncomingMessage) => {
      const statusCode = response.statusCode;
      response.destroy();
      if (statusCode === undefined || statusCode < 100 || statusCode > 599) {
        finish(() => reject(Object.assign(new Error("Invalid HTTP status."), { code: "HPE_INVALID_STATUS" })));
        return;
      }
      finish(() => resolve({ statusCode, responseTimeMs: elapsed(startedAt, now) }));
    });
    timer = setTimeout(() => {
      requestObject.destroy(timeoutError);
      finish(() => reject(timeoutError));
    }, Math.max(1, deadlineAt - now()));
    timer.unref();
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    requestObject.once("error", (error) => finish(() => reject(error)));
    requestObject.end();
  });
}

/**
 * Performs a single header-only GET. DNS results are all validated and the
 * connection lookup is pinned to one validated address, preventing rebinding.
 */
export async function probeHttp(
  rawTarget: string,
  deadlineMs = 10_000,
  dependencies: ProbeDependencies = {},
): Promise<ProbeResult> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  try {
    const target = new URL(rawTarget);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new TargetBlockedError();
    }
    const pinned = await resolveTarget(target.hostname, dependencies.resolver ?? defaultResolver, deadlineAt, now);
    const response = await makeRequest(
      chooseRequest(target.protocol, dependencies.request),
      target,
      pinned.address,
      pinned.family,
      deadlineAt,
      startedAt,
      now,
      dependencies.signal,
    );
    return {
      ok: true,
      httpStatus: response.statusCode,
      responseTimeMs: response.responseTimeMs,
      totalDurationMs: elapsed(startedAt, now),
    };
  } catch (error) {
    return { ok: false, errorCode: classifyError(error), totalDurationMs: elapsed(startedAt, now) };
  }
}
