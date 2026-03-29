/**
 * Payment Service — wraps AgentPay PUBLIC API for creating payment intents.
 *
 * Agent GoFundMe is a platform that facilitates payments between third parties
 * (donors → campaign creators, creators → platform fees). The platform itself
 * never pays — it creates intents via the unauthenticated /api endpoints and
 * returns payment requirements so the actual payer can sign and settle.
 *
 * SDK reference: @cross402/usdc PublicPayClient
 * API docs: https://docs.agent.tech/
 */

import type { Env } from "../types";
import { getConfig } from "../config";

// ─── Types ─────────────────────────────────────────────────────

interface CreateIntentParams {
  recipient: string;    // wallet address that receives the USDC
  amount: string;       // USDC amount (e.g. "10.00")
  payerChain: string;   // source chain (e.g. "base", "solana")
}

/** X402 payment requirements — everything the payer needs to sign and pay */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

interface FeeBreakdown {
  sourceChain: string;
  sourceChainFee: string;
  targetChain: string;
  targetChainFee: string;
  platformFee: string;
  platformFeePercentage: string;
  totalFee: string;
}

export interface CreateIntentResponse {
  intentId: string;
  status: string;
  expiresAt: string;
  paymentRequirements: PaymentRequirements;
  feeBreakdown?: FeeBreakdown;
  merchantRecipient: string;
  sendingAmount: string;
  receivingAmount: string;
  estimatedFee: string;
}

interface GetIntentResponse {
  intentId: string;
  status: string;
  recipient?: string;
  amount?: string;
  baseTxHash?: string;
  payerWallet?: string;
  completedAt?: string;
}

// ─── Utility: snake_case → camelCase ───────────────────────────

function keysToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(keysToCamel);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        keysToCamel(v),
      ])
    );
  }
  return obj;
}

// ─── PaymentService ────────────────────────────────────────────

/**
 * PaymentService wraps the AgentPay PUBLIC API (/api prefix).
 *
 * No credentials are needed. The platform creates payment intents specifying
 * a recipient wallet, and returns paymentRequirements to the actual payer.
 * The payer signs the X402 payment and submits a settle_proof.
 */
export class PaymentService {
  private baseUrl: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.baseUrl = config.agentPay.baseUrl;
  }

  /**
   * Create a payment intent via the public API.
   *
   * POST /api/intents — no authentication required.
   *
   * Returns the full intent including paymentRequirements, which the payer
   * needs to construct and sign their X402 payment.
   */
  async createIntent(params: CreateIntentParams): Promise<CreateIntentResponse> {
    const body: Record<string, string> = {
      recipient: params.recipient,
      amount: params.amount,
      payer_chain: params.payerChain,
    };

    const res = await fetch(`${this.baseUrl}/api/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay createIntent failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const raw = await res.json();
    const data = keysToCamel(raw) as Record<string, unknown>;

    return {
      intentId: data.intentId as string,
      status: data.status as string,
      expiresAt: data.expiresAt as string,
      paymentRequirements: data.paymentRequirements as PaymentRequirements,
      feeBreakdown: data.feeBreakdown as FeeBreakdown | undefined,
      merchantRecipient: data.merchantRecipient as string,
      sendingAmount: data.sendingAmount as string,
      receivingAmount: data.receivingAmount as string,
      estimatedFee: data.estimatedFee as string,
    };
  }

  /**
   * Submit a settle proof after the payer has completed X402 payment.
   *
   * POST /api/intents/{intent_id} — no authentication required.
   */
  async submitProof(
    intentId: string,
    settleProof: string
  ): Promise<{ status: string; baseTxHash?: string }> {
    const res = await fetch(
      `${this.baseUrl}/api/intents/${encodeURIComponent(intentId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settle_proof: settleProof }),
      }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay submitProof failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const raw = await res.json();
    const data = keysToCamel(raw) as Record<string, unknown>;
    return {
      status: data.status as string,
      baseTxHash: (data.basePayment as Record<string, string> | undefined)
        ?.txHash,
    };
  }

  /**
   * Get intent status and receipt via the public API.
   *
   * GET /api/intents?intent_id=... — no authentication required.
   */
  async getIntent(intentId: string): Promise<GetIntentResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/intents?intent_id=${encodeURIComponent(intentId)}`,
      { method: "GET" }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay getIntent failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const raw = await res.json();
    const data = keysToCamel(raw) as Record<string, unknown>;
    return {
      intentId: data.intentId as string,
      status: data.status as string,
      recipient: data.merchantRecipient as string | undefined,
      amount: data.receivingAmount as string | undefined,
      baseTxHash: (data.basePayment as Record<string, string> | undefined)
        ?.txHash,
      payerWallet: data.payerWallet as string | undefined,
      completedAt: data.completedAt as string | undefined,
    };
  }

  /**
   * Verify that an AgentPay intent has settled and paid the expected recipient.
   *
   * Works for intents created via the public API — checks status === BASE_SETTLED,
   * recipient matches, and amount >= required minimum.
   */
  async verifyIntentSettled(
    intentId: string,
    expectedRecipient: string,
    minimumAmount: string
  ): Promise<{ verified: boolean; txHash?: string; details?: string }> {
    try {
      const intent = await this.getIntent(intentId);

      if (intent.status !== "BASE_SETTLED") {
        return {
          verified: false,
          details:
            `Intent status is "${intent.status}", expected "BASE_SETTLED". ` +
            `The payment may still be processing — try again in a few seconds.`,
        };
      }

      // Check recipient matches expected wallet
      if (
        intent.recipient &&
        intent.recipient.toLowerCase() !== expectedRecipient.toLowerCase()
      ) {
        return {
          verified: false,
          details: `Intent recipient ${intent.recipient} does not match expected wallet ${expectedRecipient}.`,
        };
      }

      // Check amount >= minimum
      if (intent.amount) {
        const intentAmount = parseFloat(intent.amount);
        const requiredAmount = parseFloat(minimumAmount);
        if (intentAmount < requiredAmount) {
          return {
            verified: false,
            details: `Intent amount ${intent.amount} is less than required ${minimumAmount}.`,
          };
        }
      }

      return { verified: true, txHash: intent.baseTxHash };
    } catch (err) {
      return {
        verified: false,
        details: `Failed to verify intent: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** Typed error for payment failures */
export class PaymentError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: string
  ) {
    super(message);
    this.name = "PaymentError";
  }
}
