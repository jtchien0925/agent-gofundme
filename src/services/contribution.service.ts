/**
 * Contribution Service — create, execute, and track campaign contributions
 * Uses AgentPay intents for multi-chain USDC payments (https://docs.agent.tech/)
 */

import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId } from "./crypto";
import { PaymentService } from "./payment.service";
import { CampaignService } from "./campaign.service";
import type { Env } from "../types";

export class ContributionService {
  private payment: PaymentService;
  private campaignService: CampaignService;

  constructor(
    private db: Database,
    env: Env
  ) {
    this.payment = new PaymentService(env);
    this.campaignService = new CampaignService(db, env);
  }

  /**
   * Start a contribution by creating an AgentPay intent.
   * The intent sends USDC directly to the campaign creator's wallet.
   * https://docs.agent.tech/api/intents/#createintent
   */
  async create(params: {
    campaignId: string;
    agentId?: string;
    amount: string;
    payerChain: string;
    flowType: "server" | "client";
  }) {
    // Validate campaign exists and is active
    const campaign = await this.campaignService.getById(params.campaignId);
    if (!campaign) throw new ContributionError("Campaign not found", 404);
    if (campaign.status !== "active" && campaign.status !== "funded") {
      throw new ContributionError(
        "Campaign is not accepting contributions",
        400
      );
    }

    // Check deadline
    if (new Date(campaign.deadline) < new Date()) {
      throw new ContributionError("Campaign has expired", 400);
    }

    // Look up the campaign creator's wallet to send funds directly
    const creator = await this.db.query.agents.findFirst({
      where: eq(schema.agents.id, campaign.agentId),
    });
    if (!creator) throw new ContributionError("Campaign creator not found", 500);

    // Create AgentPay intent — sends USDC to campaign creator's wallet
    const intent = await this.payment.createIntent({
      recipient: creator.walletAddress,
      amount: params.amount,
      payerChain: params.payerChain,
    });

    const id = generateId();
    await this.db.insert(schema.contributions).values({
      id,
      campaignId: params.campaignId,
      agentId: params.agentId || null,
      amount: parseFloat(params.amount),
      payerChain: params.payerChain,
      intentId: intent.intentId,
      intentStatus: "AWAITING_PAYMENT",
      flowType: params.flowType,
    });

    return {
      contribution: await this.getById(id),
      intent: {
        intentId: intent.intentId,
        expiresAt: intent.expiresAt,
        feeBreakdown: intent.feeBreakdown,
      },
    };
  }

  /**
   * Execute a contribution server-side (agent wallet signs).
   * https://docs.agent.tech/api/intents/#executeintent
   */
  async execute(contributionId: string, agentId?: string) {
    const contribution = await this.getById(contributionId);
    if (!contribution) throw new ContributionError("Contribution not found", 404);
    if (contribution.flowType !== "server") {
      throw new ContributionError(
        "This contribution uses client-side flow. Use submitProof instead.",
        400
      );
    }
    if (contribution.intentStatus !== "AWAITING_PAYMENT") {
      throw new ContributionError(
        `Cannot execute: intent is ${contribution.intentStatus}`,
        400
      );
    }

    const result = await this.payment.executeIntent(contribution.intentId);

    await this.db
      .update(schema.contributions)
      .set({
        intentStatus: result.status,
        baseTxHash: result.baseTxHash || null,
        settledAt:
          result.status === "BASE_SETTLED"
            ? new Date().toISOString()
            : null,
      })
      .where(eq(schema.contributions.id, contributionId));

    // If settled, update campaign raised amount
    if (result.status === "BASE_SETTLED") {
      await this.campaignService.recordContribution(
        contribution.campaignId,
        contribution.amount
      );
    }

    return this.getById(contributionId);
  }

  /**
   * Submit a settlement proof (client-side flow).
   * https://docs.agent.tech/api/intents/#submitproof
   */
  async submitProof(contributionId: string, settleProof: string) {
    const contribution = await this.getById(contributionId);
    if (!contribution) throw new ContributionError("Contribution not found", 404);
    if (contribution.flowType !== "client") {
      throw new ContributionError(
        "This contribution uses server-side flow. Use execute instead.",
        400
      );
    }

    const result = await this.payment.submitProof(
      contribution.intentId,
      settleProof
    );

    await this.db
      .update(schema.contributions)
      .set({
        intentStatus: result.status,
        baseTxHash: result.baseTxHash || null,
        settledAt:
          result.status === "BASE_SETTLED"
            ? new Date().toISOString()
            : null,
      })
      .where(eq(schema.contributions.id, contributionId));

    // If settled, update campaign raised amount
    if (result.status === "BASE_SETTLED") {
      await this.campaignService.recordContribution(
        contribution.campaignId,
        contribution.amount
      );
    }

    return this.getById(contributionId);
  }

  /** Get contribution by ID */
  async getById(id: string) {
    return this.db.query.contributions.findFirst({
      where: eq(schema.contributions.id, id),
    });
  }

  /** Get all contributions for a campaign */
  async getByCampaignId(campaignId: string, limit = 50, offset = 0) {
    return this.db.query.contributions.findMany({
      where: eq(schema.contributions.campaignId, campaignId),
      orderBy: [desc(schema.contributions.createdAt)],
      limit,
      offset,
    });
  }

  /**
   * Poll and sync intent status from AgentPay.
   * Call this to refresh a contribution's status.
   * https://docs.agent.tech/api/intents/#getintent
   */
  async syncStatus(contributionId: string) {
    const contribution = await this.getById(contributionId);
    if (!contribution) throw new ContributionError("Contribution not found", 404);

    // Don't poll terminal states
    const terminalStates = [
      "BASE_SETTLED",
      "EXPIRED",
      "VERIFICATION_FAILED",
      "PARTIAL_SETTLEMENT",
    ];
    if (terminalStates.includes(contribution.intentStatus)) {
      return contribution;
    }

    const intent = await this.payment.getIntent(contribution.intentId);

    const updates: Record<string, unknown> = {
      intentStatus: intent.status,
    };

    if (intent.baseTxHash) updates.baseTxHash = intent.baseTxHash;
    if (intent.status === "BASE_SETTLED") {
      updates.settledAt = new Date().toISOString();
    }

    await this.db
      .update(schema.contributions)
      .set(updates)
      .where(eq(schema.contributions.id, contributionId));

    // If just settled, update campaign
    if (
      intent.status === "BASE_SETTLED" &&
      contribution.intentStatus !== "BASE_SETTLED"
    ) {
      await this.campaignService.recordContribution(
        contribution.campaignId,
        contribution.amount
      );
    }

    return this.getById(contributionId);
  }
}

export class ContributionError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "ContributionError";
  }
}
