/**
 * Authentication middleware — verifies X-Agent-Key header
 */

import type { Context, Next } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { AgentService } from "../services/agent.service";

type HonoEnv = { Bindings: Env; Variables: { agent: Record<string, unknown>; agentId: string } };

/** Require authentication — returns 401 if no valid key */
export function requireAuth() {
  return async (c: Context<HonoEnv>, next: Next) => {
    const apiKey = c.req.header("X-Agent-Key");

    if (!apiKey) {
      return c.json(
        { ok: false, error: "Missing X-Agent-Key header" },
        401
      );
    }

    const db = createDb(c.env.DB);
    const agentService = new AgentService(db);
    const agent = await agentService.authenticate(apiKey);

    if (!agent) {
      return c.json({ ok: false, error: "Invalid API key" }, 401);
    }

    // Attach agent to context for downstream use
    c.set("agent", agent);
    c.set("agentId", agent.id);

    await next();
  };
}

/** Optional auth — attaches agent if key provided, continues either way */
export function optionalAuth() {
  return async (c: Context<HonoEnv>, next: Next) => {
    const apiKey = c.req.header("X-Agent-Key");

    if (apiKey) {
      const db = createDb(c.env.DB);
      const agentService = new AgentService(db);
      const agent = await agentService.authenticate(apiKey);
      if (agent) {
        c.set("agent", agent);
        c.set("agentId", agent.id);
      }
    }

    await next();
  };
}
