/**
 * Campaign Service — create, update, activate, close campaigns
 *
 * Fee flow (v2 — direct on-chain):
 *   The platform charges a flat 0.50 USDC activation fee. Instead of an
 *   AgentPay intent (which only the creating account can execute), creators
 *   send USDC directly to the platform wallet on Base chain and submit the
 *   tx hash. The platform verifies the transfer on-chain via Base RPC.
 *
 * Contributions still use AgentPay intents (creator ≠ payer, so that works).
 */

import { eq, and, sql } from "drizzle-orm";
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
   * Returns payment instructions — the creator must send 0.50 USDC to the
   * platform wallet on Base, then call POST /activate with the tx hash.
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
      category: params.category as "compute" | "api_credits" | "infrastructure" | "research" | "community" | "other",
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
        chain: "base",
        recipient: this.platformWallet,
        token_contract: USDC_BASE,
        message: `Send ${this.campaignFee} USDC to ${this.platformWallet} on Base chain, then call POST /v1/campaigns/${id}/activate with { "tx_hash": "<your_tx_hash>" }.`,
      },
    };
  }

  /**
   * Activate a campaign — requires a Base chain tx hash proving the creator
   * sent the activation fee (0.50 USDC) to the platform wallet.
   *
   * The tx hash is verified on-chain via Base RPC (eth_getTransactionReceipt).
   * If the tx contains a USDC Transfer event to the platform wallet for ≥ fee
   * amount, the campaign is activated.
   *
   * If no tx_hash is provided, returns payment instructions (402).
   */
  async activate(campaignId: string, agentId: string, txHash?: string) {
    const campaign = await this.getById(campaignId);
    if (!campaign) throw new CampaignError("Campaign not found", 404);
    if (campaign.agentId !== agentId) throw new CampaignError("Not your campaign", 403);
    if (campaign.status !== "draft") throw new CampaignError("Campaign is not in draft status", 400);

    // If already paid (e.g. via old intent flow), just activate
    if (campaign.feePaid) {
      await this.db
        .update(schema.campaigns)
        .set({ status: "active", updatedAt: new Date().toISOString() })
        .where(eq(schema.campaigns.id, campaignId));
      return { status: "activated" as const, campaign: await this.getById(campaignId) };
    }

    // No tx hash provided — return payment instructions
    if (!txHash) {
      return {
        status: "pending_payment" as const,
        fee: {
          amount: this.campaignFee,
          currency: "USDC",
          chain: "base",
          recipient: this.platformWallet,
          token_contract: USDC_BASE,
          instructions: [
            `Send ${this.campaignFee} USDC to ${this.platformWallet} on Base chain.`,
            `Then call POST /v1/campaigns/${campaignId}/activate with { "tx_hash": "<your_tx_hash>" }.`,
          ],
        },
      };
    }

    // Detect: intent_id (UUID) vs tx_hash (0x hex)
    const isIntentId = !txHash.startsWith("0x");
    let verified = false;
    let verificationDetails = "";

    if (isIntentId) {
      // Verify via AgentPay API — check intent settled and paid platform
      const result = await this.payment.verifyIntentSettled(
        txHash,
        this.platformWallet,
        this.campaignFee
      );
      verified = result.verified;
      if (!verified) {
        verificationDetails = result.details || "Intent verification failed";
      }
      // If intent verified and has a base tx hash, store that for audit trail
      if (result.txHash) {
        txHash = result.txHash; // Use the actual on-chain tx hash for storage
      }
    } else {
      // Verify directly on-chain via Base RPC
      verified = await this.verifyFeeTx(txHash);
      if (!verified) {
        verificationDetails =
          `Transaction ${txHash} could not be verified as a valid fee payment. ` +
          `Expected: ≥${this.campaignFee} USDC transfer to ${this.platformWallet} on Base.`;
      }
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
        feeIntentId: txHash, // store tx hash for audit trail
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
        return false; // tx failed or not found
      }

      // ERC-20 Transfer event topic: Transfer(address,address,uint256)
      const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const platformPadded = "0x" + this.platformWallet.slice(2).toLowerCase().padStart(64, "0");
      const feeInWei = BigInt(Math.round(parseFloat(this.campaignFee) * 1e6)); // USDC has 6 decimals

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
      // RPC error — don't block activation, log and allow retry
      throw new CampaignError("Failed to verify transaction on Base chain. Please try again.", 503);
    }
  }

  /**
   * Legacy pay-fee endpoint — accepts a tx hash and verifies on-chain.
   * Kept for backward compatibility with agents that use /pay-fee instead of /activate.
   */
  async payFee(campaignId: string, agentId: string, txHash: string) {
    return this.activate(campaignId, agentId, txHash);
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
