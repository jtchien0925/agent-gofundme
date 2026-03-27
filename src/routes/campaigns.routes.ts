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
import { CreateCampaignSchema, UpdateCampaignSchema } from "../types/api";

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

/** POST /v1/campaigns/:id/activate — Pay fee and activate campaign */
campaigns.post("/:id/activate", requireAuth(), async (c) => {
  const id = c.req.param("id")!;
  const agentId = c.get("agentId") as string;

  const db = createDb(c.env.DB);
  const service = new CampaignService(db, c.env);

  const campaign = await service.activate(id, agentId);

  return c.json({
    ok: true,
    data: campaign,
    message: "Campaign is now active and accepting contributions.",
  });
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
