import { describe, expect, it } from "vitest";

import { isPublicAddress, validatePublicAddresses } from "@/worker/address";

describe("public address validation", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) ("accepts global unicast address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("rejects a DNS answer set when even one address is unsafe", () => {
    expect(validatePublicAddresses(["1.1.1.1", "127.0.0.1"])).toBe(false);
  });
});
