/**
 * Campaign Service — create, update, activate, close campaigns
 * Fee payments use AgentPay (https://docs.agent.tech/)
 */

import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId } from "./crypto";
import { PaymentService } from "./payment.service";
import type { Env } from "../types";
import { getConfig } from "../config";

export class CampaignService {
  private payment: PaymentService;
  private platformWallet: string;
  private campaignFee: string;

  constructor(
    private db: Database,
    env: Env
  ) {
    this.payment = new PaymentService(env);
    const config = getConfig(env);
    this.platformWallet = config.platform.wallet;
    this.campaignFee = config.platform.campaignFeeUsdc;
  }

  /**
   * Create a campaign (status: DRAFT).
   * Also creates an AgentPay intent for the 0.50 USDC creation fee.
   * The agent must pay the fee and call activate() to go live.
   */
  async create(
    agentId: string,
    params: {
      title: string;
      description: string;
      category: string;
      campaignType: string;
      goalAmount: string;
      deadline: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    const id = generateId();

    // Create AgentPay intent for the creation fee
    // https://docs.agent.tech/api/intents/#createintent
    const feeIntent = await this.payment.createIntent({
      recipient: this.platformWallet,
      amount: this.campaignFee,
      payerChain: "base", // fee always on Base (cheapest)
    });

    await this.db.insert(schema.campaigns).values({
      id,
      agentId,
      title: params.title,
      description: params.description,
      category: params.category as "compute" | "api_credits" | "infrastructure" | "research" | "community" | "other",
      campaignType: params.campaignType as "self_fund" | "project_fund",
      goalAmount: parseFloat(params.goalAmount),
      raisedAmount: 0,
      contributorCount: 0,
      status: "draft",
      feeIntentId: feeIntent.intentId,
      feePaid: false,
      deadline: params.deadline,
      metadata: params.metadata || null,
    });

    const campaign = await this.getById(id);

    return {
      campaign,
      fee: {
        intentId: feeIntent.intentId,
        amount: this.campaignFee,
        currency: "USDC",
        chain: "base",
        expiresAt: feeIntent.expiresAt,
        message: `Pay ${this.campaignFee} USDC to activate this campaign. Execute the intent or submit proof within 10 minutes.`,
      },
    };
  }

  /**
   * Activate a campaign after fee is paid.
   * Executes the fee intent server-side, then sets status to ACTIVE.
   */
  async activate(campaignId: string, agentId: string) {
    const campaign = await this.getById(campaignId);
    if (!campaign) throw new CampaignError("Campaign not found", 404);
    if (campaign.agentId !== agentId) throw new CampaignError("Not your campaign", 403);
    if (campaign.status !== "draft") throw new CampaignError("Campaign is not in draft status", 400);
    if (!campaign.feeIntentId) throw new CampaignError("No fee intent found", 400);

    // Check if already settled, otherwise execute the fee payment
    // https://docs.agent.tech/api/intents/#executeintent
    let result = await this.payment.getIntent(campaign.feeIntentId);

    if (result.status === "AWAITING_PAYMENT") {
      result = await this.payment.executeIntent(campaign.feeIntentId);
    }

    if (result.status === "BASE_SETTLED") {
      await this.db
        .update(schema.campaigns)
        .set({
          status: "active",
          feePaid: true,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.campaigns.id, campaignId));

      return this.getById(campaignId);
    }

    throw new CampaignError(
      `Fee payment not settled. Status: ${result.status}`,
      402
    );
  }

  /** Get campaign by ID */
  async getById(id: string) {
    return this.db.query.campaigns.findFirst({
      where: eq(schema.campaigns.id, id),
    });
  }

  /** Update campaign (owner only, limited fields) */
  async update(
    id: string,
    agentId: string,
    params: {
      title?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    const campaign = await this.getById(id);
    if (!campaign) throw new CampaignError("Campaign not found", 404);
    if (campaign.agentId !== agentId) throw new CampaignError("Not your campaign", 403);
    if (campaign.status === "closed" || campaign.status === "expired") {
      throw new CampaignError("Cannot update a closed or expired campaign", 400);
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (params.title) updates.title = params.title;
    if (params.description) updates.description = params.description;
    if (params.metadata !== undefined) updates.metadata = params.metadata;

    await this.db
      .update(schema.campaigns)
      .set(updates)
      .where(eq(schema.campaigns.id, id));

    return this.getById(id);
  }

  /** Close a campaign (owner only) */
  async close(id: string, agentId: string) {
    const campaign = await this.getById(id);
    if (!campaign) throw new CampaignError("Campaign not found", 404);
    if (campaign.agentId !== agentId) throw new CampaignError("Not your campaign", 403);
    if (campaign.status === "closed" || campaign.status === "expired") {
      throw new CampaignError("Campaign is already closed or expired", 400);
    }

    await this.db
      .update(schema.campaigns)
      .set({ status: "closed", updatedAt: new Date().toISOString() })
      .where(eq(schema.campaigns.id, id));

    return this.getById(id);
  }

  /** Record a settled contribution — update raised amount and check goal */
  async recordContribution(campaignId: string, amount: number) {
    const campaign = await this.getById(campaignId);
    if (!campaign) return;

    const newRaised = campaign.raisedAmount + amount;
    const newCount = campaign.contributorCount + 1;
    const newStatus =
      newRaised >= campaign.goalAmount ? "funded" : campaign.status;

    await this.db
      .update(schema.campaigns)
      .set({
        raisedAmount: newRaised,
        contributorCount: newCount,
        status: newStatus,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.campaigns.id, campaignId));
  }

  /** Get campaigns by agent ID */
  async getByAgentId(agentId: string) {
    return this.db.query.campaigns.findMany({
      where: eq(schema.campaigns.agentId, agentId),
    });
  }
}

export class CampaignError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "CampaignError";
  }
}
