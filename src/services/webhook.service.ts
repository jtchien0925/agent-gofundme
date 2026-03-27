/**
 * Webhook Service — register, manage, and deliver webhook events
 * All payloads are HMAC-SHA256 signed for agent verification
 */

import { eq, and } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId, generateWebhookSecret, hmacSign } from "./crypto";
import type { WebhookEventType } from "../types";

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export class WebhookService {
  constructor(private db: Database) {}

  /** Register a new webhook */
  async create(params: {
    agentId: string;
    url: string;
    events: string[];
  }) {
    const id = generateId();
    const secret = generateWebhookSecret();

    await this.db.insert(schema.webhooks).values({
      id,
      agentId: params.agentId,
      url: params.url,
      events: params.events,
      secret,
      active: true,
      failureCount: 0,
    });

    const webhook = await this.getById(id);
    return { ...webhook, secret }; // Secret only shown on creation
  }

  /** Get webhook by ID */
  async getById(id: string) {
    return this.db.query.webhooks.findFirst({
      where: eq(schema.webhooks.id, id),
    });
  }

  /** List webhooks for an agent */
  async listByAgent(agentId: string) {
    const hooks = await this.db.query.webhooks.findMany({
      where: eq(schema.webhooks.agentId, agentId),
    });
    // Don't expose secrets in list
    return hooks.map(({ secret, ...rest }) => rest);
  }

  /** Update a webhook */
  async update(
    id: string,
    agentId: string,
    params: {
      url?: string;
      events?: string[];
      active?: boolean;
    }
  ) {
    const webhook = await this.getById(id);
    if (!webhook) throw new WebhookError("Webhook not found", 404);
    if (webhook.agentId !== agentId) throw new WebhookError("Not your webhook", 403);

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (params.url) updates.url = params.url;
    if (params.events) updates.events = params.events;
    if (params.active !== undefined) updates.active = params.active;

    await this.db
      .update(schema.webhooks)
      .set(updates)
      .where(eq(schema.webhooks.id, id));

    const updated = await this.getById(id);
    if (!updated) return null;
    const { secret, ...safe } = updated;
    return safe;
  }

  /** Delete a webhook */
  async remove(id: string, agentId: string) {
    const webhook = await this.getById(id);
    if (!webhook) throw new WebhookError("Webhook not found", 404);
    if (webhook.agentId !== agentId) throw new WebhookError("Not your webhook", 403);

    await this.db
      .delete(schema.webhooks)
      .where(eq(schema.webhooks.id, id));
  }

  /**
   * Fire a webhook event to all matching subscribers.
   * Uses waitUntil() in Workers to avoid blocking the response.
   */
  async fire(
    event: WebhookEventType,
    agentId: string,
    data: Record<string, unknown>,
    ctx?: ExecutionContext
  ) {
    const hooks = await this.db.query.webhooks.findMany({
      where: and(
        eq(schema.webhooks.agentId, agentId),
        eq(schema.webhooks.active, true)
      ),
    });

    const matchingHooks = hooks.filter((h) =>
      (h.events as string[]).includes(event)
    );

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const deliveries = matchingHooks.map((hook) =>
      this.deliver(hook, payload)
    );

    // Use waitUntil if available (Cloudflare Workers)
    if (ctx) {
      ctx.waitUntil(Promise.allSettled(deliveries));
    } else {
      await Promise.allSettled(deliveries);
    }
  }

  /** Deliver a single webhook with HMAC signature */
  private async deliver(
    hook: typeof schema.webhooks.$inferSelect,
    payload: WebhookPayload
  ) {
    const body = JSON.stringify(payload);
    const signature = await hmacSign(hook.secret, body);

    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentGoFundMe-Signature": signature,
          "X-AgentGoFundMe-Event": payload.event,
        },
        body,
      });

      if (!res.ok) {
        await this.recordFailure(hook.id);
      } else {
        // Reset failure count on success
        if (hook.failureCount > 0) {
          await this.db
            .update(schema.webhooks)
            .set({ failureCount: 0 })
            .where(eq(schema.webhooks.id, hook.id));
        }
      }
    } catch {
      await this.recordFailure(hook.id);
    }
  }

  /** Record a delivery failure. Disable after 10 consecutive failures. */
  private async recordFailure(hookId: string) {
    const hook = await this.getById(hookId);
    if (!hook) return;

    const newCount = hook.failureCount + 1;
    await this.db
      .update(schema.webhooks)
      .set({
        failureCount: newCount,
        active: newCount >= 10 ? false : hook.active,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.webhooks.id, hookId));
  }
}

export class WebhookError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "WebhookError";
  }
}
