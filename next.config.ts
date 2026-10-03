import type { NextConfig } from "next";

const configuredDevOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: configuredDevOrigins,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" }] : []),
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
      ],
    }];
  },
};

export default nextConfig;
