import type { Database } from "../db";

// ─── Cloudflare Worker Bindings ─────────────────────────────
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  AGENTPAY_API_KEY: string;
  AGENTPAY_SECRET_KEY: string;
  AGENTPAY_BASE_URL: string;
  PLATFORM_WALLET: string;
  CAMPAIGN_FEE_USDC: string;
  ENVIRONMENT: string;
}

// ─── App Context (passed through Hono) ──────────────────────
export interface AppContext {
  db: Database;
  env: Env;
  agent?: AgentRecord | null;
}

// ─── Database Record Types ──────────────────────────────────
export interface AgentRecord {
  id: string;
  name: string;
  type: "self" | "managed" | "autonomous";
  description: string | null;
  apiKeyHash: string;
  walletAddress: string;
  reputation: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecord {
  id: string;
  agentId: string;
  title: string;
  description: string;
  category: string;
  campaignType: string;
  goalAmount: number;
  raisedAmount: number;
  contributorCount: number;
  status: string;
  feeIntentId: string | null;
  feePaid: boolean;
  deadline: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContributionRecord {
  id: string;
  campaignId: string;
  agentId: string | null;
  amount: number;
  payerChain: string;
  intentId: string;
  intentStatus: string;
  baseTxHash: string | null;
  flowType: string;
  createdAt: string;
  settledAt: string | null;
}

// ─── API Response Types ─────────────────────────────────────
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ─── Webhook Event Types ────────────────────────────────────
export type WebhookEventType =
  | "contribution.created"
  | "contribution.settled"
  | "contribution.failed"
  | "campaign.activated"
  | "campaign.milestone"
  | "campaign.funded"
  | "campaign.expired"
  | "campaign.closed";
