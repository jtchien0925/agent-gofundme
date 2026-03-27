/**
 * Rate limiting middleware using Workers KV
 * Default: 60 requests per minute per IP
 */

import type { Context, Next } from "hono";
import type { Env } from "../types";

type HonoEnv = { Bindings: Env };

const DEFAULT_LIMIT = 60; // requests
const DEFAULT_WINDOW = 60; // seconds

export function rateLimit(limit = DEFAULT_LIMIT, windowSeconds = DEFAULT_WINDOW) {
  return async (c: Context<HonoEnv>, next: Next) => {
    const kv = c.env.KV;
    if (!kv) {
      // KV not available (local dev) — skip rate limiting
      return next();
    }

    const ip = c.req.header("CF-Connecting-IP") || c.req.header("x-forwarded-for") || "unknown";
    const key = `ratelimit:${ip}`;

    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      return c.json(
        {
          ok: false,
          error: "Rate limit exceeded",
          message: `Maximum ${limit} requests per ${windowSeconds} seconds`,
        },
        429
      );
    }

    // Increment counter with TTL
    await kv.put(key, String(count + 1), {
      expirationTtl: windowSeconds,
    });

    // Add rate limit headers
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(limit - count - 1));

    await next();
  };
}
