/**
 * Contribution routes — create, execute, submit proof, check status
 * Payments processed via AgentPay (https://docs.agent.tech/)
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { ContributionService } from "../services/contribution.service";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { CreateContributionSchema, SubmitProofSchema } from "../types/api";

type HonoEnv = { Bindings: Env; Variables: { agent: Record<string, unknown>; agentId: string } };

const contributions = new Hono<HonoEnv>();

/** POST /v1/campaigns/:campaignId/contribute — Start a contribution */
contributions.post(
  "/campaigns/:campaignId/contribute",
  optionalAuth(),
  async (c) => {
    const campaignId = c.req.param("campaignId")!;
    const body = await c.req.json();
    const params = CreateContributionSchema.parse(body);
    const agentId = c.get("agentId") as string || undefined;

    const db = createDb(c.env.DB);
    const service = new ContributionService(db, c.env);

    const result = await service.create({
      campaignId,
      agentId,
      amount: params.amount,
      payerChain: params.payer_chain,
      flowType: params.flow_type,
    });

    return c.json({ ok: true, data: result }, 201);
  }
);

/** POST /v1/contributions/:id/execute — Execute contribution (server-side) */
contributions.post("/:id/execute", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  const contribution = await service.execute(id, agentId);

  return c.json({ ok: true, data: contribution });
});

/** POST /v1/contributions/:id/proof — Submit settlement proof (client-side) */
contributions.post("/:id/proof", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const params = SubmitProofSchema.parse(body);

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  const contribution = await service.submitProof(id, params.settle_proof);

  return c.json({ ok: true, data: contribution });
});

/** GET /v1/contributions/:id — Get contribution status */
contributions.get("/:id", async (c) => {
  const id = c.req.param("id")!;

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  // Sync status from AgentPay first
  const contribution = await service.syncStatus(id);

  return c.json({ ok: true, data: contribution });
});

export { contributions };
