import { isIP } from "node:net";

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return Number.NaN;
    }
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function inIpv4Cidr(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

const blockedIpv4Cidrs: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // RFC 1918
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // RFC 1918
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay anycast
  [0xc0a80000, 16], // RFC 1918
  [0xc0afc200, 24], // benchmark testing
  [0xc6120000, 15], // benchmark testing
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast and reserved
];

function ipv6Number(address: string): bigint | null {
  const noZone = address.split("%", 1)[0]!;
  if (noZone.includes(".")) {
    const lastColon = noZone.lastIndexOf(":");
    if (lastColon < 0) {
      return null;
    }
    const tail = ipv4Number(noZone.slice(lastColon + 1));
    if (tail === null) {
      return null;
    }
    const prefix = `${noZone.slice(0, lastColon)}:${((tail >>> 16) & 0xffff).toString(16)}:${(tail & 0xffff).toString(16)}`;
    return ipv6Number(prefix);
  }

  const halves = noZone.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) {
    return null;
  }
  const fields = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  let result = 0n;
  for (const field of fields) {
    if (!/^[0-9a-f]{1,4}$/i.test(field)) {
      return null;
    }
    result = (result << 16n) + BigInt(`0x${field}`);
  }
  return result;
}

function inIpv6Cidr(address: bigint, network: bigint, prefix: number): boolean {
  const bits = 128n;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (bits - BigInt(prefix));
  return (address & mask) === (network & mask);
}

const ipv6 = (value: string): bigint => BigInt(`0x${value.replaceAll(":", "")}`);
const blockedIpv6Cidrs: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 128], // unspecified
  [1n, 128], // loopback
  [ipv6("00000000000000000000ffff00000000"), 96], // IPv4 mapped
  [ipv6("0064ff9b000100000000000000000000"), 48], // IPv4/IPv6 translation
  [ipv6("01000000000000000000000000000000"), 64], // discard-only
  [ipv6("20000000000000000000000000000000"), 23], // IETF special-purpose ranges
  [BigInt("0x20010db8") << 96n, 32], // documentation
  [ipv6("20020000000000000000000000000000"), 16], // 6to4, embeds unvalidated IPv4
  [ipv6("fc000000000000000000000000000000"), 7], // unique local
  [ipv6("fe800000000000000000000000000000"), 10], // link-local
  [ipv6("ff000000000000000000000000000000"), 8], // multicast
];

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const numeric = ipv4Number(address);
    return numeric !== null && !blockedIpv4Cidrs.some(([network, prefix]) => inIpv4Cidr(numeric, network, prefix));
  }
  if (family === 6) {
    const numeric = ipv6Number(address);
    return (
      numeric !== null &&
      inIpv6Cidr(numeric, ipv6("20000000000000000000000000000000"), 3) &&
      !blockedIpv6Cidrs.some(([network, prefix]) => inIpv6Cidr(numeric, network, prefix))
    );
  }
  return false;
}

export function validatePublicAddresses(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isPublicAddress);
}
