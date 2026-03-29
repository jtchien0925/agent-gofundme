/**
 * Campaign routes — create, update, activate, close, list contributions
 * Campaign fees paid via AgentPay (https://docs.agent.tech/)
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { CampaignService } from "../services/campaign.service";
import { ContributionService } from "../services/contribution.service";
import { requireAuth } from "../middleware/auth";
import { z } from "zod";
import { CreateCampaignSchema, UpdateCampaignSchema } from "../types/api";

/** Accept tx_hash, settle_proof, or intent_id for backward compatibility */
const ActivateCampaignSchema = z.object({
  tx_hash: z.string().optional(),
  settle_proof: z.string().optional(),
  intent_id: z.string().optional(),
});

const PayFeeSchema = z.object({
  tx_hash: z.string().optional(),
  settle_proof: z.string().optional(),
  intent_id: z.string().optional(),
});

type HonoEnv = { Bindings: Env; Variables: { agent: Record<string, unknown>; agentId: string } };

const campaigns = new Hono<HonoEnv>();

/** POST /v1/campaigns — Create a new campaign (DRAFT status, triggers fee intent) */
campaigns.post("/", requireAuth(), async (c) => {
  const body = await c.req.json();
  const params = CreateCampaignSchema.parse(body);
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const result = await service.create(agentId, {
    title: params.title,
    description: params.description,
    category: params.category,
    campaignType: params.campaign_type,
    goalAmount: params.goal_amount,
    deadline: params.deadline,
    metadata: params.metadata,
  });

  return c.json({ ok: true, data: result }, 201);
});

/** GET /v1/campaigns/:id — Get campaign details (public) */
campaigns.get("/:id", async (c) => {
  const id = c.req.param("id")!;
  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const campaign = await service.getById(id);
  if (!campaign) {
    return c.json({ ok: false, error: "Campaign not found" }, 404);
  }

  return c.json({
    ok: true,
    data: {
      ...campaign,
      progress:
        campaign.goalAmount > 0
          ? Math.round((campaign.raisedAmount / campaign.goalAmount) * 100 * 10) / 10
          : 0,
    },
  });
});

/** PATCH /v1/campaigns/:id — Update campaign (owner only) */
campaigns.patch("/:id", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const params = UpdateCampaignSchema.parse(body);
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const updated = await service.update(id, agentId, {
    title: params.title,
    description: params.description,
    metadata: params.metadata,
  });

  return c.json({ ok: true, data: updated });
});

/**
 * POST /v1/campaigns/:id/activate — Activate campaign after paying the fee.
 *
 * Two modes:
 *   1. No body / empty body → returns 402 with payment instructions (wallet address, amount).
 *   2. Body: { tx_hash: "0x..." } → verifies the Base chain tx, activates if valid.
 *
 * The tx must be a USDC transfer to the platform wallet for ≥ 0.50 USDC on Base.
 */
campaigns.post("/:id/activate", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  let txHash: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ActivateCampaignSchema.parse(body);
    txHash = parsed.tx_hash || parsed.settle_proof || parsed.intent_id;
  } catch {
    // body is optional
  }

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const result = await service.activate(id, agentId, txHash);

  if (result.status === "activated") {
    return c.json({
      ok: true,
      data: result.campaign,
      message: "Campaign is now active and accepting contributions.",
    });
  }

  // Fee not yet paid — 402 Payment Required with instructions
  return c.json(
    {
      ok: false,
      error: `Fee not yet paid. Send ${result.fee?.amount} USDC to ${result.fee?.recipient} on Base chain, then call /activate again with { "tx_hash": "<your_tx_hash>" }.`,
      data: result.fee,
    },
    402
  );
});

/**
 * POST /v1/campaigns/:id/pay-fee — Submit on-chain tx hash as fee payment proof.
 *
 * Accepts { tx_hash: "0x..." } — a Base chain tx hash for a USDC transfer
 * to the platform wallet. Verifies on-chain, activates if valid.
 */
campaigns.post("/:id/pay-fee", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const body = await c.req.json();
  const parsed = PayFeeSchema.parse(body);
  const txHash = parsed.tx_hash || parsed.settle_proof || parsed.intent_id;
  if (!txHash) {
    return c.json({ ok: false, error: "tx_hash is required" }, 400);
  }

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const result = await service.payFee(id, agentId, txHash);

  if (result.status === "activated") {
    return c.json({
      ok: true,
      data: result.campaign,
      message: "Fee verified on-chain. Campaign is now active and accepting contributions.",
    });
  }

  return c.json({ ok: false, error: "Fee verification failed" }, 402);
});

/** POST /v1/campaigns/:id/close — Close campaign (owner only) */
campaigns.post("/:id/close", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const campaign = await service.close(id, agentId);

  return c.json({ ok: true, data: campaign });
});

/** GET /v1/campaigns/:id/contributions — List campaign contributions (public) */
campaigns.get("/:id/contributions", async (c) => {
  const id = c.req.param("id")!;
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  const db = createDb(c.env.DB);
  const contributionService = new ContributionService(db, c.env);

  const contributions = await contributionService.getByCampaignId(id, limit, offset);

  return c.json({ ok: true, data: contributions });
});

/** GET /v1/campaigns/me/list — List my campaigns */
campaigns.get("/me/list", requireAuth(), async (c) => {
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const myCampaigns = await service.getByAgentId(agentId);

  return c.json({ ok: true, data: myCampaigns });
});

export { campaigns };
