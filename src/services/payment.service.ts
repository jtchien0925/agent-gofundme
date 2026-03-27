/**
 * Payment Service — wraps AgentPay SDK for creating/executing USDC payment intents.
 * All payments settle on Base chain via https://docs.agent.tech/
 */

import type { Env } from "../types";
import { getConfig } from "../config";

interface CreateIntentParams {
  email?: string;
  recipient?: string;
  amount: string;
  payerChain: string;
}

interface IntentResponse {
  intentId: string;
  status: string;
  expiresAt?: string;
  feeBreakdown?: {
    sourceChain: string;
    sourceChainFee: string;
    targetChain: string;
    targetChainFee: string;
    platformFee: string;
    platformFeePercentage: string;
    totalFee: string;
  };
}

interface ExecuteResponse {
  status: string;
  baseTxHash?: string;
}

/**
 * PaymentService provides a thin wrapper around the AgentPay REST API.
 *
 * We call the HTTP endpoints directly instead of using the @cross402/usdc SDK
 * because Cloudflare Workers use V8 isolates (not Node.js), and the SDK may
 * depend on Node-specific APIs. Raw fetch is universally compatible.
 *
 * API reference: https://docs.agent.tech/api/intents/
 */
export class PaymentService {
  private baseUrl: string;
  private authHeader: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.baseUrl = config.agentPay.baseUrl;

    // Bearer token = base64(apiKey:secretKey)
    // https://docs.agent.tech/api/auth/
    const credentials = `${config.agentPay.apiKey}:${config.agentPay.secretKey}`;
    this.authHeader = `Bearer ${btoa(credentials)}`;
  }

  /** Create a payment intent — https://docs.agent.tech/api/intents/#createintent */
  async createIntent(params: CreateIntentParams): Promise<IntentResponse> {
    const body: Record<string, string> = {
      amount: params.amount,
      payer_chain: params.payerChain,
    };

    if (params.email) body.email = params.email;
    if (params.recipient) body.recipient = params.recipient;

    const res = await fetch(`${this.baseUrl}/v2/intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
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

    const data = (await res.json()) as Record<string, unknown>;
    return {
      intentId: data.intent_id as string,
      status: data.status as string,
      expiresAt: data.expires_at as string | undefined,
      feeBreakdown: data.fee_breakdown
        ? {
            sourceChain: (data.fee_breakdown as Record<string, string>).source_chain,
            sourceChainFee: (data.fee_breakdown as Record<string, string>).source_chain_fee,
            targetChain: (data.fee_breakdown as Record<string, string>).target_chain,
            targetChainFee: (data.fee_breakdown as Record<string, string>).target_chain_fee,
            platformFee: (data.fee_breakdown as Record<string, string>).platform_fee,
            platformFeePercentage: (data.fee_breakdown as Record<string, string>).platform_fee_percentage,
            totalFee: (data.fee_breakdown as Record<string, string>).total_fee,
          }
        : undefined,
    };
  }

  /** Execute an intent server-side — https://docs.agent.tech/api/intents/#executeintent */
  async executeIntent(intentId: string): Promise<ExecuteResponse> {
    const res = await fetch(`${this.baseUrl}/v2/intents/${intentId}/execute`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay executeIntent failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      status: data.status as string,
      baseTxHash: data.base_tx_hash as string | undefined,
    };
  }

  /** Submit a settlement proof (client-side flow) — https://docs.agent.tech/api/intents/#submitproof */
  async submitProof(
    intentId: string,
    settleProof: string
  ): Promise<ExecuteResponse> {
    // Public endpoint — no auth required
    const res = await fetch(`${this.baseUrl}/api/intents/${intentId}/proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settle_proof: settleProof }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay submitProof failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      status: data.status as string,
      baseTxHash: data.base_tx_hash as string | undefined,
    };
  }

  /** Get intent status — https://docs.agent.tech/api/intents/#getintent */
  async getIntent(intentId: string): Promise<{
    intentId: string;
    status: string;
    baseTxHash?: string;
  }> {
    const res = await fetch(`${this.baseUrl}/v2/intents?intent_id=${intentId}`, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new PaymentError(
        `AgentPay getIntent failed: ${res.status}`,
        res.status,
        errorBody
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      intentId: data.intent_id as string,
      status: data.status as string,
      baseTxHash: (data.base_payment as Record<string, string> | undefined)?.tx_hash,
    };
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
