/**
 * Agent routes — registration, profile, API key management
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { AgentService } from "../services/agent.service";
import { requireAuth } from "../middleware/auth";
import { CreateAgentSchema, UpdateAgentSchema } from "../types/api";

type HonoEnv = { Bindings: Env; Variables: { agent: Record<string, unknown>; agentId: string } };

const agents = new Hono<HonoEnv>();

/** POST /v1/agents — Register a new agent */
agents.post("/", async (c) => {
  const body = await c.req.json();
  const params = CreateAgentSchema.parse(body);

  const db = createDb(c.env.DB);
  const service = new AgentService(db);

  const result = await service.register({
    name: params.name,
    type: params.type,
    description: params.description,
    walletAddress: params.wallet_address,
  });

  return c.json(
    {
      ok: true,
      data: {
        agent: result.agent,
        api_key: result.apiKey,
        message:
          "Store this API key securely — it will not be shown again. Use it in the X-Agent-Key header for authenticated requests.",
      },
    },
    201
  );
});

/** GET /v1/agents/me — Get current agent profile */
agents.get("/me", requireAuth(), async (c) => {
  const agent = c.get("agent");
  return c.json({ ok: true, data: agent });
});

/** PATCH /v1/agents/me — Update agent profile */
agents.patch("/me", requireAuth(), async (c) => {
  const body = await c.req.json();
  const params = UpdateAgentSchema.parse(body);
  const agentId = c.get("agentId");

  const db = createDb(c.env.DB);
  const service = new AgentService(db);

  const updated = await service.update(agentId, {
    name: params.name,
    description: params.description,
    walletAddress: params.wallet_address,
  });

  return c.json({ ok: true, data: updated });
});

/** POST /v1/agents/me/rotate-key — Rotate API key */
agents.post("/me/rotate-key", requireAuth(), async (c) => {
  const agentId = c.get("agentId");

  const db = createDb(c.env.DB);
  const service = new AgentService(db);

  const result = await service.rotateKey(agentId);

  return c.json({
    ok: true,
    data: {
      api_key: result.apiKey,
      message: "New API key generated. The old key is now invalid.",
    },
  });
});

export { agents };
