/**
 * Webhook routes — register, list, update, delete webhooks
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { WebhookService } from "../services/webhook.service";
import { requireAuth } from "../middleware/auth";
import { CreateWebhookSchema, UpdateWebhookSchema } from "../types/api";

type HonoEnv = { Bindings: Env; Variables: { agent: Record<string, unknown>; agentId: string } };

const webhooks = new Hono<HonoEnv>();

// All webhook routes require authentication
webhooks.use("/*", requireAuth());

/** POST /v1/webhooks — Register a new webhook */
webhooks.post("/", async (c) => {
  const body = await c.req.json();
  const params = CreateWebhookSchema.parse(body);
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new WebhookService(db);

  const webhook = await service.create({
    agentId,
    url: params.url,
    events: params.events,
  });

  return c.json(
    {
      ok: true,
      data: webhook,
      message:
        "Webhook registered. The signing secret is only shown once — store it securely to verify payload signatures.",
    },
    201
  );
});

/** GET /v1/webhooks — List my webhooks */
webhooks.get("/", async (c) => {
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new WebhookService(db);

  const hooks = await service.listByAgent(agentId);

  return c.json({ ok: true, data: hooks });
});

/** PATCH /v1/webhooks/:id — Update a webhook */
webhooks.patch("/:id", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const params = UpdateWebhookSchema.parse(body);
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new WebhookService(db);

  const updated = await service.update(id, agentId, {
    url: params.url,
    events: params.events,
    active: params.active,
  });

  return c.json({ ok: true, data: updated });
});

/** DELETE /v1/webhooks/:id — Remove a webhook */
webhooks.delete("/:id", async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new WebhookService(db);

  await service.remove(id, agentId);

  return c.json({ ok: true, message: "Webhook removed" });
});

export { webhooks };
