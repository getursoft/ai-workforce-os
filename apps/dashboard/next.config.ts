import type { NextConfig } from "next";

export function buildContentSecurityPolicy(
  environment = process.env.NEXT_PUBLIC_APP_ENV,
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL
): string {
  const productionLike = environment === "production" || environment === "staging";
  const apiOrigin = safeOrigin(apiBaseUrl ?? "http://localhost:4000/api/v1");
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(!productionLike ? ["'unsafe-eval'"] : [])
  ];
  const connectSources = [
    "'self'",
    apiOrigin,
    ...(!productionLike ? ["ws://localhost:3000", "ws://127.0.0.1:3000"] : [])
  ];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`
  ].join("; ");
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.origin;
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTP or HTTPS URL.");
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Dev-only: the dashboard is also reachable via a Cloudflare Tunnel at https://krevia.in, proxying
  // to this same local dev server. Next.js's dev server blocks (403 "Unauthorized") any cross-origin
  // request to its internal /_next/* dev resources (notably the Turbopack/webpack HMR websocket) whose
  // Origin header doesn't match an allowed host — krevia.in isn't localhost, so every such request was
  // being rejected, breaking the HMR handshake and, with it, client-side hydration for the whole page
  // (observed as the login form falling back to a native, unhandled HTML GET submission instead of
  // React's onSubmit firing). Has no effect in production builds (`next start`), where this dev-only
  // check doesn't run.
  allowedDevOrigins: ["krevia.in"],
  async redirects() {
    // Self-service signup was removed (the platform has one universal owner). Stale bookmarks/links
    // to /signup redirect to the login page instead of 404ing.
    return [{ source: "/signup", destination: "/login", permanent: true }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
          },
          {
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy()
          }
        ]
      }
    ];
  }
};

export default nextConfig;
