import { describe, expect, it } from "vitest";

import { CreateServiceRequestSchema } from "@/shared/contracts";

describe("CreateServiceRequestSchema", () => {
  it("applies production defaults", () => {
    expect(
      CreateServiceRequestSchema.parse({ name: "Status", url: "https://status.example.com" }),
    ).toMatchObject({
      intervalSeconds: 60,
      acceptedStatusMin: 200,
      acceptedStatusMax: 299,
    });
  });

  it("rejects unknown fields and inverted status ranges", () => {
    expect(() =>
      CreateServiceRequestSchema.parse({
        name: "Status",
        url: "https://status.example.com",
        acceptedStatusMin: 400,
        acceptedStatusMax: 200,
      }),
    ).toThrow();
    expect(() =>
      CreateServiceRequestSchema.parse({
        name: "Status",
        url: "https://status.example.com",
        unexpected: true,
      }),
    ).toThrow();
  });
});
