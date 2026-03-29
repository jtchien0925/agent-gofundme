/**
 * Campaign routes — create, update, activate, close, list contributions
 *
 * Fee payment flow (v3 — public API):
 *   POST /activate with { payer_chain } → get paymentRequirements
 *   Creator pays with own wallet
 *   POST /activate with { intent_id | tx_hash | settle_proof } → verify & activate
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { CampaignService } from "../services/campaign.service";
import { ContributionService } from "../services/contribution.service";
import { requireAuth } from "../middleware/auth";
import { z } from "zod";
import { CreateCampaignSchema, UpdateCampaignSchema, SUPPORTED_CHAINS } from "../types/api";

/**
 * Activate schema — flexible input:
 *   { payer_chain } → create intent, get paymentRequirements
 *   { tx_hash }     → verify on-chain USDC transfer
 *   { intent_id }   → verify settled AgentPay intent
 *   { settle_proof } → submit proof for stored intent
 */
const ActivateCampaignSchema = z.object({
  tx_hash: z.string().optional(),
  settle_proof: z.string().optional(),
  intent_id: z.string().optional(),
  payer_chain: z.string().optional(),
});

const PayFeeSchema = z.object({
  tx_hash: z.string().optional(),
  settle_proof: z.string().optional(),
  intent_id: z.string().optional(),
  payer_chain: z.string().optional(),
});

type HonoEnv = {
  Bindings: Env;
  Variables: { agent: Record<string, unknown>; agentId: string };
};

const campaigns = new Hono<HonoEnv>();

/** POST /v1/campaigns — Create a new campaign (DRAFT status) */
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

/** GET /v1/campaigns — List campaigns (redirects to discover) */
campaigns.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  // Return active campaigns — same as /v1/discover but unfiltered
  const campaigns_list = await service.listActive(
    parseInt(c.req.query("limit") || "20"),
    parseInt(c.req.query("offset") || "0")
  );

  return c.json({ ok: true, data: campaigns_list });
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
          ? Math.round(
              (campaign.raisedAmount / campaign.goalAmount) * 100 * 10
            ) / 10
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
 * POST /v1/campaigns/:id/activate — Activate a campaign.
 *
 * Step 1 (get intent):
 *   Body: { payer_chain: "base" }
 *   → Returns AgentPay intent with paymentRequirements
 *   → Creator pays with their own wallet
 *
 * Step 2 (verify & activate):
 *   Body: { intent_id: "uuid" } or { tx_hash: "0x..." } or { settle_proof: "..." }
 *   → Platform verifies payment, activates campaign
 *
 * If no body → returns 402 with payment instructions.
 */
campaigns.post("/:id/activate", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  let opts:
    | {
        txHash?: string;
        settleProof?: string;
        intentId?: string;
        payerChain?: string;
      }
    | undefined;

  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ActivateCampaignSchema.parse(body);
    opts = {
      txHash: parsed.tx_hash,
      settleProof: parsed.settle_proof,
      intentId: parsed.intent_id,
      payerChain: parsed.payer_chain,
    };
  } catch {
    // body is optional
  }

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const result = await service.activate(id, agentId, opts);

  if (result.status === "activated") {
    return c.json({
      ok: true,
      data: result.campaign,
      message: "Campaign is now active and accepting contributions.",
    });
  }

  if (result.status === "awaiting_payment") {
    return c.json(
      {
        ok: true,
        data: result.intent,
        message:
          "Payment intent created. Use the paymentRequirements to pay with your wallet, " +
          "then call /activate again with the intent_id or settle_proof.",
      },
      402
    );
  }

  // pending_payment — return fee instructions
  return c.json(
    {
      ok: false,
      error: `Fee not yet paid.`,
      data: result.fee,
    },
    402
  );
});

/**
 * POST /v1/campaigns/:id/pay-fee — Submit fee payment proof.
 * Alias for /activate — kept for backward compatibility.
 */
campaigns.post("/:id/pay-fee", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const body = await c.req.json();
  const parsed = PayFeeSchema.parse(body);

  const txHash = parsed.tx_hash || parsed.intent_id;
  const settleProof = parsed.settle_proof;
  const payerChain = parsed.payer_chain;

  if (!txHash && !settleProof && !payerChain) {
    return c.json(
      {
        ok: false,
        error:
          "Provide tx_hash, intent_id, settle_proof, or payer_chain",
      },
      400
    );
  }

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const result = await service.activate(id, agentId, {
    txHash,
    settleProof,
    payerChain,
  });

  if (result.status === "activated") {
    return c.json({
      ok: true,
      data: result.campaign,
      message:
        "Fee verified. Campaign is now active and accepting contributions.",
    });
  }

  if (result.status === "awaiting_payment") {
    return c.json(
      {
        ok: true,
        data: result.intent,
        message: "Payment intent created. Pay and submit proof.",
      },
      402
    );
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

  const contributions = await contributionService.getByCampaignId(
    id,
    limit,
    offset
  );

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
