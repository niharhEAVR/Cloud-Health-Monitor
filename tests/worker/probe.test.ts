import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { probeHttp } from "@/worker/probe";

function response(statusCode: number): IncomingMessage {
  return Object.assign(new EventEmitter(), {
    statusCode,
    destroy: vi.fn(),
  }) as unknown as IncomingMessage;
}

function successfulRequest(statusCode: number, inspect?: (options: RequestOptions) => void): typeof import("node:http").request {
  return ((options: RequestOptions, callback: (message: IncomingMessage) => void) => {
    inspect?.(options);
    const request = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => callback(response(statusCode))),
      destroy: vi.fn(),
    });
    return request as unknown as ClientRequest;
  }) as typeof import("node:http").request;
}

const publicResolver = {
  resolve4: async () => ["1.1.1.1"],
  resolve6: async () => [],
};

describe("safe HTTP probe", () => {
  it("pins the connection while retaining the original hostname for Host and TLS SNI", async () => {
    let options: RequestOptions | undefined;
    const result = await probeHttp("https://status.example.test/health?secret=not-logged", 1_000, {
      resolver: publicResolver,
      request: successfulRequest(204, (value) => {
        options = value;
      }),
    });

    expect(result).toMatchObject({ ok: true, httpStatus: 204 });
    expect(options?.hostname).toBe("status.example.test");
    expect((options as RequestOptions & { servername?: string }).servername).toBe("status.example.test");
    expect(options?.agent).toBe(false);
    expect(options?.maxHeaderSize).toBe(16 * 1024);
    expect(options?.headers).not.toHaveProperty("Host");
    await new Promise<void>((resolve, reject) => {
      options?.lookup?.("status.example.test", {}, (error, address, family) => {
        try {
          expect(error).toBeNull();
          expect(address).toBe("1.1.1.1");
          expect(family).toBe(4);
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });
  });

  it("records redirects as terminal responses and never follows them", async () => {
    const request = vi.fn(successfulRequest(302));
    const result = await probeHttp("http://example.test/redirect", 1_000, {
      resolver: publicResolver,
      request: request as unknown as typeof import("node:http").request,
    });

    expect(result).toMatchObject({ ok: true, httpStatus: 302 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects DNS rebinding answer sets before opening a socket", async () => {
    const request = vi.fn(successfulRequest(200));
    const result = await probeHttp("https://rebind.example.test", 1_000, {
      resolver: {
        resolve4: async () => ["1.1.1.1", "127.0.0.1"],
        resolve6: async () => [],
      },
      request: request as unknown as typeof import("node:http").request,
    });

    expect(result).toMatchObject({ ok: false, errorCode: "TARGET_BLOCKED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("classifies failed DNS resolution without exposing resolver details", async () => {
    const result = await probeHttp("https://missing.example.test", 1_000, {
      resolver: {
        resolve4: async () => {
          throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
        },
        resolve6: async () => [],
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "DNS_ERROR" });
  });

  it("applies a wall-clock deadline while DNS is unresolved", async () => {
    const result = await probeHttp("https://slow.example.test", 5, {
      resolver: {
        resolve4: async () => new Promise<string[]>(() => undefined),
        resolve6: async () => new Promise<string[]>(() => undefined),
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "TIMEOUT" });
  });
});
