import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/server/env";

const validEnvironment = {
  APP_ORIGIN: "https://monitor.example.com",
  DATABASE_URL: "postgres://monitor:password@localhost:5432/monitor",
};

describe("parseServerEnv", () => {
  it("parses defaults and normalizes the application origin", () => {
    expect(parseServerEnv(validEnvironment)).toMatchObject({
      APP_ORIGIN: "https://monitor.example.com",
      DATABASE_POOL_MAX: 10,
      MAX_SERVICES: 100,
      WORKER_CONCURRENCY: 5,
    });
  });

  it("rejects an application origin with a path", () => {
    expect(() => parseServerEnv({ ...validEnvironment, APP_ORIGIN: "https://monitor.example.com/app" })).toThrow();
  });
});
