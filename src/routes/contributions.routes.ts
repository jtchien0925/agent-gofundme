/**
 * Contribution routes — create, settle (proof or tx_hash), check status
 *
 * Payment flow (v3 — public API):
 *   POST /contribute → creates intent, returns paymentRequirements
 *   Donor pays using their own wallet (X402 or direct USDC transfer)
 *   POST /settle → donor submits settle_proof or tx_hash
 *   GET /:id → check status (auto-syncs with AgentPay)
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { ContributionService } from "../services/contribution.service";
import { optionalAuth } from "../middleware/auth";
import { z } from "zod";
import { SUPPORTED_CHAINS } from "../types/api";

/** Create contribution — amount and payer chain */
const CreateContributionSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Invalid USDC amount")
    .refine((v) => parseFloat(v) >= 0.02, "Minimum contribution is 0.02 USDC")
    .refine((v) => parseFloat(v) <= 1_000_000, "Maximum is 1,000,000 USDC"),
  payer_chain: z.enum(SUPPORTED_CHAINS),
});

/** Settle contribution — settle_proof (X402) or tx_hash (on-chain) */
const SettleContributionSchema = z.object({
  settle_proof: z.string().min(1).optional(),
  tx_hash: z.string().min(1).optional(),
  intent_id: z.string().min(1).optional(), // alias for backward compat
});

type HonoEnv = {
  Bindings: Env;
  Variables: { agent: Record<string, unknown>; agentId: string };
};

const contributions = new Hono<HonoEnv>();

/**
 * POST /v1/campaigns/:campaignId/contribute — Start a contribution.
 *
 * Creates a payment intent via AgentPay public API. Returns
 * paymentRequirements so the donor can pay with their own wallet.
 * No platform credentials are involved.
 */
contributions.post(
  "/campaigns/:campaignId/contribute",
  optionalAuth(),
  async (c) => {
    const campaignId = c.req.param("campaignId")!;
    const body = await c.req.json();
    const params = CreateContributionSchema.parse(body);
    const agentId = (c.get("agentId") as string) || undefined;

    const db = createDb(c.env.DB);
    const service = new ContributionService(db, c.env);

    const result = await service.create({
      campaignId,
      agentId,
      amount: params.amount,
      payerChain: params.payer_chain,
    });

    return c.json({ ok: true, data: result }, 201);
  }
);

/**
 * POST /v1/contributions/:id/settle — Settle a contribution.
 *
 * The donor submits proof of payment:
 *   - { settle_proof: "..." } for X402 flow (AgentPay signs)
 *   - { tx_hash: "0x..." } for direct USDC transfer on Base
 *   - { intent_id: "..." } for AgentPay intent verification
 *
 * The platform verifies the payment and records the contribution.
 */
contributions.post("/:id/settle", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const params = SettleContributionSchema.parse(body);

  if (!params.settle_proof && !params.tx_hash && !params.intent_id) {
    return c.json(
      {
        ok: false,
        error:
          "Either settle_proof, tx_hash, or intent_id is required",
      },
      400
    );
  }

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  const contribution = await service.settle(id, {
    settleProof: params.settle_proof,
    txHash: params.tx_hash || params.intent_id,
  });

  return c.json({ ok: true, data: contribution });
});

/**
 * POST /v1/contributions/:id/proof — Submit settlement proof (legacy endpoint).
 * Alias for /settle with settle_proof.
 */
contributions.post("/:id/proof", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const params = z
    .object({ settle_proof: z.string().min(1) })
    .parse(body);

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  const contribution = await service.settle(id, {
    settleProof: params.settle_proof,
  });

  return c.json({ ok: true, data: contribution });
});

/** GET /v1/contributions/:id — Get contribution status (auto-syncs) */
contributions.get("/:id", async (c) => {
  const id = c.req.param("id")!;

  const db = createDb(c.env.DB);
  const service = new ContributionService(db, c.env);

  // Sync status from AgentPay first
  const contribution = await service.syncStatus(id);

  return c.json({ ok: true, data: contribution });
});

export { contributions };
