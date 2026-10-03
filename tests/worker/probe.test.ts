import { EventEmitter, once } from "node:events";
import { createServer, request as nativeRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createPinnedLookup, probeHttp } from "@/worker/probe";

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

  it("pins a bracketed public IPv6 literal without trying DNS", async () => {
    let options: RequestOptions | undefined;
    const resolver = { resolve4: vi.fn(), resolve6: vi.fn() };
    const result = await probeHttp("http://[2606:4700:4700::1111]/health", 1_000, {
      resolver,
      request: successfulRequest(204, (value) => { options = value; }),
    });

    expect(result).toMatchObject({ ok: true, httpStatus: 204 });
    expect(options?.hostname).toBe("2606:4700:4700::1111");
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(resolver.resolve6).not.toHaveBeenCalled();
  });

  it("uses Node 24's all-address lookup callback shape with a real socket", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP test server.");
    let requestedAll = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const request = nativeRequest({
          hostname: "pinned.invalid",
          port: String(address.port),
          agent: false,
          autoSelectFamily: true,
          lookup: (hostname, options, callback) => {
            requestedAll ||= options.all === true;
            createPinnedLookup("127.0.0.1", 4)(hostname, options, callback);
          },
        } as RequestOptions & { autoSelectFamily: boolean }, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
        request.end();
      });
      expect(requestedAll).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
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
