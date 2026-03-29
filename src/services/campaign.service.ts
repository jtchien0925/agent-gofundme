/**
 * Campaign Service — create, update, activate, close campaigns.
 *
 * Fee flow (v3 — public API + on-chain):
 *   The platform charges a flat 0.50 USDC activation fee. Creators can pay
 *   two ways:
 *
 *   1. Via AgentPay: POST /activate with { payer_chain } → platform creates
 *      a public intent (no auth), returns paymentRequirements. Creator pays
 *      with their own wallet, then calls POST /activate again with the
 *      intent_id or settle_proof.
 *
 *   2. Direct USDC transfer: Send USDC to platform wallet on Base, then
 *      call POST /activate with { tx_hash }.
 *
 *   The platform NEVER uses its own credentials to create or execute intents.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId } from "./crypto";
import { PaymentService } from "./payment.service";
import type { Env } from "../types";
import { getConfig } from "../config";

/** Base mainnet RPC for verifying USDC transfers */
const BASE_RPC = "https://mainnet.base.org";
/** USDC contract on Base */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

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
   * Returns fee payment instructions — two options:
   *   1. Direct transfer: send USDC to platform wallet on Base
   *   2. AgentPay: call POST /activate with { payer_chain } to get an intent
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

    await this.db.insert(schema.campaigns).values({
      id,
      agentId,
      title: params.title,
      description: params.description,
      category: params.category as
        | "compute"
        | "api_credits"
        | "infrastructure"
        | "research"
        | "community"
        | "other",
      campaignType: params.campaignType as "self_fund" | "project_fund",
      goalAmount: parseFloat(params.goalAmount),
      raisedAmount: 0,
      contributorCount: 0,
      status: "draft",
      feeIntentId: null,
      feePaid: false,
      deadline: params.deadline,
      metadata: params.metadata || null,
    });

    const campaign = await this.getById(id);

    return {
      campaign,
      fee: {
        amount: this.campaignFee,
        currency: "USDC",
        instructions: {
          option_a: {
            method: "agentpay",
            description:
              "Call POST /v1/campaigns/" +
              id +
              '/activate with { "payer_chain": "base" } to get paymentRequirements. ' +
              "Pay with your wallet, then call /activate again with the intent_id.",
          },
          option_b: {
            method: "direct_transfer",
            chain: "base",
            recipient: this.platformWallet,
            token_contract: USDC_BASE,
            description:
              `Send ${this.campaignFee} USDC to ${this.platformWallet} on Base, ` +
              `then call POST /v1/campaigns/${id}/activate with { "tx_hash": "0x..." }.`,
          },
        },
      },
    };
  }

  /**
   * Activate a campaign — verify fee payment.
   *
   * Three modes:
   *   1. { payer_chain } → create AgentPay intent, return paymentRequirements
   *   2. { tx_hash: "0x..." } → verify on-chain USDC transfer
   *   3. { intent_id | settle_proof } → verify via AgentPay
   *   4. No body → return payment instructions (402)
   */
  async activate(
    campaignId: string,
    agentId: string,
    opts?: {
      txHash?: string;
      settleProof?: string;
      intentId?: string;
      payerChain?: string;
    }
  ) {
    const campaign = await this.getById(campaignId);
    if (!campaign) throw new CampaignError("Campaign not found", 404);
    if (campaign.agentId !== agentId)
      throw new CampaignError("Not your campaign", 403);
    if (campaign.status !== "draft")
      throw new CampaignError("Campaign is not in draft status", 400);

    // If already paid (e.g. via old intent flow), just activate
    if (campaign.feePaid) {
      await this.db
        .update(schema.campaigns)
        .set({ status: "active", updatedAt: new Date().toISOString() })
        .where(eq(schema.campaigns.id, campaignId));
      return {
        status: "activated" as const,
        campaign: await this.getById(campaignId),
      };
    }

    // Mode 1: payer_chain provided → create intent, return paymentRequirements
    if (opts?.payerChain && !opts.txHash && !opts.settleProof && !opts.intentId) {
      const intent = await this.payment.createIntent({
        recipient: this.platformWallet,
        amount: this.campaignFee,
        payerChain: opts.payerChain,
      });

      // Store the intent ID for later verification
      await this.db
        .update(schema.campaigns)
        .set({
          feeIntentId: intent.intentId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.campaigns.id, campaignId));

      return {
        status: "awaiting_payment" as const,
        intent: {
          intentId: intent.intentId,
          expiresAt: intent.expiresAt,
          paymentRequirements: intent.paymentRequirements,
          feeBreakdown: intent.feeBreakdown,
          recipient: this.platformWallet,
          amount: this.campaignFee,
        },
      };
    }

    // Mode 2-3: verify payment proof
    const proofValue = opts?.txHash || opts?.settleProof || opts?.intentId;

    if (!proofValue) {
      // No proof provided → return payment instructions
      return {
        status: "pending_payment" as const,
        fee: {
          amount: this.campaignFee,
          currency: "USDC",
          chain: "base",
          recipient: this.platformWallet,
          token_contract: USDC_BASE,
          instructions: [
            `Option A: Call POST /v1/campaigns/${campaignId}/activate with { "payer_chain": "base" } to get an AgentPay intent with paymentRequirements.`,
            `Option B: Send ${this.campaignFee} USDC to ${this.platformWallet} on Base, then call /activate again with { "tx_hash": "0x..." }.`,
          ],
        },
      };
    }

    // Detect proof type and verify
    let verified = false;
    let verificationDetails = "";
    let auditTxHash = proofValue;

    if (opts?.settleProof && campaign.feeIntentId) {
      // Submit settle proof to AgentPay for the stored intent
      try {
        const result = await this.payment.submitProof(
          campaign.feeIntentId,
          opts.settleProof
        );
        if (result.status === "BASE_SETTLED") {
          verified = true;
          if (result.baseTxHash) auditTxHash = result.baseTxHash;
        } else {
          verificationDetails = `Proof submitted but status is "${result.status}". Payment may still be processing.`;
        }
      } catch (err) {
        verificationDetails = `Failed to submit proof: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (proofValue.startsWith("0x")) {
      // Raw tx_hash → verify on-chain
      verified = await this.verifyFeeTx(proofValue);
      if (!verified) {
        verificationDetails =
          `Transaction ${proofValue} could not be verified as a valid fee payment. ` +
          `Expected: ≥${this.campaignFee} USDC transfer to ${this.platformWallet} on Base.`;
      }
    } else {
      // UUID-like → intent_id, verify via AgentPay
      const result = await this.payment.verifyIntentSettled(
        proofValue,
        this.platformWallet,
        this.campaignFee
      );
      verified = result.verified;
      if (!verified) {
        verificationDetails =
          result.details || "Intent verification failed";
      }
      if (result.txHash) auditTxHash = result.txHash;
    }

    if (!verified) {
      throw new CampaignError(verificationDetails, 402);
    }

    // Verified — activate the campaign
    await this.db
      .update(schema.campaigns)
      .set({
        status: "active",
        feePaid: true,
        feeIntentId: auditTxHash,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.campaigns.id, campaignId));

    return {
      status: "activated" as const,
      campaign: await this.getById(campaignId),
    };
  }

  /**
   * Verify a Base chain transaction is a valid fee payment.
   * Checks the tx receipt for a USDC Transfer event to the platform wallet
   * with value ≥ campaignFee.
   */
  private async verifyFeeTx(txHash: string): Promise<boolean> {
    try {
      const res = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      });

      const data = (await res.json()) as {
        result?: {
          status: string;
          logs: Array<{
            address: string;
            topics: string[];
            data: string;
          }>;
        };
      };

      if (!data.result || data.result.status !== "0x1") {
        return false;
      }

      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const platformPadded =
        "0x" +
        this.platformWallet.slice(2).toLowerCase().padStart(64, "0");
      const feeInWei = BigInt(
        Math.round(parseFloat(this.campaignFee) * 1e6)
      );

      for (const log of data.result.logs) {
        if (
          log.address.toLowerCase() === USDC_BASE.toLowerCase() &&
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics[2]?.toLowerCase() === platformPadded
        ) {
          const amount = BigInt(log.data);
          if (amount >= feeInWei) return true;
        }
      }

      return false;
    } catch {
      throw new CampaignError(
        "Failed to verify transaction on Base chain. Please try again.",
        503
      );
    }
  }

  /**
   * Legacy pay-fee endpoint — redirects to activate.
   */
  async payFee(
    campaignId: string,
    agentId: string,
    txHash: string
  ) {
    return this.activate(campaignId, agentId, { txHash });
  }

  /** List active campaigns (public, paginated) */
  async listActive(limit = 20, offset = 0) {
    const conditions = [
      eq(schema.campaigns.status, "active"),
      eq(schema.campaigns.feePaid, true),
    ];

    const campaigns = await this.db
      .select()
      .from(schema.campaigns)
      .where(and(...conditions))
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.campaigns)
      .where(and(...conditions));

    const total = countResult[0]?.count || 0;

    return {
      campaigns: campaigns.map((c) => ({
        ...c,
        progress:
          c.goalAmount > 0
            ? Math.round((c.raisedAmount / c.goalAmount) * 100 * 10) / 10
            : 0,
      })),
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
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
    if (campaign.agentId !== agentId)
      throw new CampaignError("Not your campaign", 403);
    if (campaign.status === "closed" || campaign.status === "expired") {
      throw new CampaignError(
        "Cannot update a closed or expired campaign",
        400
      );
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
    if (campaign.agentId !== agentId)
      throw new CampaignError("Not your campaign", 403);
    if (campaign.status === "closed" || campaign.status === "expired") {
      throw new CampaignError(
        "Campaign is already closed or expired",
        400
      );
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
