import "server-only";

// Slows down password guessing. Two keys are used together:
//  - the account (email): works even when we can't tell clients apart;
//  - the client IP, but ONLY when we know how many reverse proxies sit in front of the app
//    (TRUSTED_PROXY_HOPS). X-Forwarded-For can be forged by the client, so with no trusted proxy it is ignored.
// In memory: fine for one server; a shared store is needed once the app runs on several.

export class FailureThrottle {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(keys: string[]): boolean {
    return keys.some((key) => {
      const entry = this.entries.get(key);
      return !!entry && entry.resetAt > this.now() && entry.count >= this.maxFailures;
    });
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    if (this.entries.size > 5000) this.prune(now); // keep memory bounded
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || entry.resetAt <= now) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      else entry.count += 1;
    }
  }

  clear(keys: string[]): void {
    for (const key of keys) this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }
}

/**
 * The client's IP as seen by the outermost trusted proxy, or null when unknown. With N trusted proxies the
 * real client is the Nth entry from the RIGHT of X-Forwarded-For (each proxy appends the address it saw);
 * anything further left was supplied by the client and can't be trusted.
 */
export function clientIp(request: Request, trustedHops: number): string | null {
  if (trustedHops <= 0) return null;
  const parts = (request.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const index = parts.length - trustedHops;
  return index >= 0 ? parts[index]! : null;
}

export function throttleKeys(request: Request, trustedHops: number, email?: string): string[] {
  const keys: string[] = [];
  if (email) keys.push(`acct:${email.trim().toLowerCase()}`);
  const ip = clientIp(request, trustedHops);
  if (ip) keys.push(`ip:${ip}`);
  return keys;
}

// One throttle for the whole server process, kept across dev hot-reloads.
const globalForThrottle = globalThis as unknown as { __kbLoginThrottle?: FailureThrottle; __kbPasswordChangeThrottle?: FailureThrottle };
export const loginThrottle: FailureThrottle = (globalForThrottle.__kbLoginThrottle ??= new FailureThrottle());

/** Wrong "current password" attempts when changing a password (per account and per client): 10 in 15 minutes. */
export const passwordChangeThrottle: FailureThrottle = (globalForThrottle.__kbPasswordChangeThrottle ??= new FailureThrottle(10, 15 * 60_000));
