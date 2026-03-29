/**
 * Contribution Service — create and track campaign contributions.
 *
 * Payment flow (v3 — public API):
 *   The platform creates a payment intent via AgentPay's public API
 *   (/api/intents) with the campaign creator's wallet as recipient.
 *   The donor receives paymentRequirements (X402 signing details) and
 *   pays using their own wallet. After payment, the donor either:
 *     - Submits a settle_proof (X402/AgentPay flow)
 *     - Submits a raw tx_hash (direct on-chain transfer)
 *   The platform verifies settlement and records the contribution.
 *
 * The platform NEVER executes payments on behalf of donors.
 */

import { eq, desc } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId } from "./crypto";
import { PaymentService } from "./payment.service";
import type { PaymentRequirements } from "./payment.service";
import { CampaignService } from "./campaign.service";
import type { Env } from "../types";

/** Base mainnet RPC for verifying direct USDC transfers */
const BASE_RPC = "https://mainnet.base.org";
/** USDC contract on Base */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

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
   * Start a contribution by creating a public AgentPay intent.
   *
   * The intent is created with the campaign creator's wallet as recipient.
   * Returns paymentRequirements so the donor can sign and pay with their
   * own wallet. No platform credentials are involved.
   */
  async create(params: {
    campaignId: string;
    agentId?: string;
    amount: string;
    payerChain: string;
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
    if (!creator)
      throw new ContributionError("Campaign creator not found", 500);

    // Create AgentPay intent via public API — sends USDC to creator's wallet
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
      flowType: "client", // all flows are now payer-signed
    });

    return {
      contribution: await this.getById(id),
      intent: {
        intentId: intent.intentId,
        expiresAt: intent.expiresAt,
        paymentRequirements: intent.paymentRequirements,
        feeBreakdown: intent.feeBreakdown,
        recipient: creator.walletAddress,
        amount: params.amount,
      },
    };
  }

  /**
   * Settle a contribution — the donor submits proof of payment.
   *
   * Accepts either:
   *   - settle_proof: X402 settle proof string (for AgentPay flow)
   *   - tx_hash: 0x-prefixed Base chain tx hash (for direct USDC transfer)
   *
   * The platform verifies payment, then records the contribution.
   */
  async settle(
    contributionId: string,
    proof: { settleProof?: string; txHash?: string }
  ) {
    const contribution = await this.getById(contributionId);
    if (!contribution)
      throw new ContributionError("Contribution not found", 404);
    if (contribution.intentStatus === "BASE_SETTLED") {
      throw new ContributionError("Contribution already settled", 400);
    }

    // Look up campaign creator's wallet for tx_hash verification
    const campaign = await this.campaignService.getById(
      contribution.campaignId
    );
    if (!campaign)
      throw new ContributionError("Campaign not found", 500);

    const creator = await this.db.query.agents.findFirst({
      where: eq(schema.agents.id, campaign.agentId),
    });
    if (!creator)
      throw new ContributionError("Campaign creator not found", 500);

    let status: string;
    let baseTxHash: string | undefined;

    if (proof.settleProof) {
      // X402 flow — submit proof to AgentPay
      const result = await this.payment.submitProof(
        contribution.intentId,
        proof.settleProof
      );
      status = result.status;
      baseTxHash = result.baseTxHash;
    } else if (proof.txHash) {
      // Direct on-chain flow — verify USDC transfer to creator's wallet
      const isIntentId = !proof.txHash.startsWith("0x");

      if (isIntentId) {
        // It's actually an intent_id — verify via AgentPay
        const result = await this.payment.verifyIntentSettled(
          proof.txHash,
          creator.walletAddress,
          contribution.amount.toString()
        );
        if (!result.verified) {
          throw new ContributionError(
            result.details || "Intent verification failed",
            402
          );
        }
        status = "BASE_SETTLED";
        baseTxHash = result.txHash;
      } else {
        // Raw tx_hash — verify on-chain
        const verified = await this.verifyTransferTx(
          proof.txHash,
          creator.walletAddress,
          contribution.amount
        );
        if (!verified) {
          throw new ContributionError(
            `Transaction ${proof.txHash} could not be verified as a valid payment. ` +
              `Expected: ≥${contribution.amount} USDC transfer to ${creator.walletAddress} on Base.`,
            402
          );
        }
        status = "BASE_SETTLED";
        baseTxHash = proof.txHash;
      }
    } else {
      throw new ContributionError(
        "Either settle_proof or tx_hash is required",
        400
      );
    }

    // Update contribution record
    await this.db
      .update(schema.contributions)
      .set({
        intentStatus: status,
        baseTxHash: baseTxHash || null,
        settledAt:
          status === "BASE_SETTLED" ? new Date().toISOString() : null,
      })
      .where(eq(schema.contributions.id, contributionId));

    // If settled, update campaign raised amount
    if (status === "BASE_SETTLED") {
      await this.campaignService.recordContribution(
        contribution.campaignId,
        contribution.amount
      );
    }

    return this.getById(contributionId);
  }

  /**
   * Verify a Base chain transaction is a valid USDC transfer.
   * Checks the tx receipt for a USDC Transfer event to the expected
   * recipient with value >= expected amount.
   */
  private async verifyTransferTx(
    txHash: string,
    expectedRecipient: string,
    expectedAmount: number
  ): Promise<boolean> {
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

      // ERC-20 Transfer event: Transfer(address,address,uint256)
      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const recipientPadded =
        "0x" +
        expectedRecipient.slice(2).toLowerCase().padStart(64, "0");
      const amountInWei = BigInt(Math.round(expectedAmount * 1e6)); // USDC 6 decimals

      for (const log of data.result.logs) {
        if (
          log.address.toLowerCase() === USDC_BASE.toLowerCase() &&
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics[2]?.toLowerCase() === recipientPadded
        ) {
          const amount = BigInt(log.data);
          if (amount >= amountInWei) return true;
        }
      }

      return false;
    } catch {
      throw new ContributionError(
        "Failed to verify transaction on Base chain. Please try again.",
        503
      );
    }
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
   */
  async syncStatus(contributionId: string) {
    const contribution = await this.getById(contributionId);
    if (!contribution)
      throw new ContributionError("Contribution not found", 404);

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
