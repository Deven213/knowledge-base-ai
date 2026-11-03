import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// Recording needs the microphone, which the app-wide Permissions-Policy used to switch off for everyone. These checks keep it allowed for
// this app's own pages only, and keep the rest of the browser-side protections exactly as they were.

async function headers(): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!();
  const all = rules.find((r) => r.source === "/:path*")!.headers;
  return Object.fromEntries(all.map((h) => [h.key, h.value]));
}

describe("the browser-side protections", () => {
  it("allows the microphone for this app's own pages and nobody else, and keeps everything else switched off", async () => {
    const policy = (await headers())["Permissions-Policy"]!;
    expect(policy).toMatch(/microphone=\(self\)/);
    expect(policy).not.toMatch(/microphone=\*|microphone=\(\*\)|microphone=\(self "/); // not for other origins
    for (const off of ["camera=()", "geolocation=()", "payment=()", "usb=()"]) expect(policy).toContain(off);
  });

  it("still lets the page talk only to this app (so a recording can only ever be sent to our own server) and plays audio from it alone", async () => {
    const csp = (await headers())["Content-Security-Policy"]!;
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1).join(" ")]));
    expect(directives["connect-src"]).toMatch(/^'self'/);
    expect(directives["connect-src"]).not.toMatch(/https?:/);
    expect(directives["default-src"]).toBe("'self'"); // no media-src of its own: audio comes from this origin only
    expect(directives["media-src"]).toBeUndefined();
    expect(directives["frame-ancestors"]).toBe("'none'");
    expect(directives["object-src"]).toBe("'none'");
  });

  it("keeps the other security headers", async () => {
    const h = await headers();
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});
