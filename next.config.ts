import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Content Security Policy sized to what the app actually loads: its own scripts/styles (Next.js
// injects inline bootstrap scripts and styles), same-origin API calls, blob: image previews for chat
// attachments, and self-hosted fonts (next/font). No third-party origins are needed in the browser:
// AI providers, OAuth token exchange and website crawling all run on the server. OAuth "Connect"
// is a top-level navigation, which CSP does not restrict.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // HTTPS-only once deployed (browsers ignore it on plain-http localhost anyway).
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // Native / ONNX modules must be loaded by Node at runtime, not bundled.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node", "unpdf", "mammoth"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
