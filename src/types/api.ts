import { z } from "zod";

// ─── Supported Chains ───────────────────────────────────────
export const SUPPORTED_CHAINS = [
  "base",
  "base-sepolia",
  "solana-mainnet-beta",
  "solana-devnet",
  "polygon",
  "polygon-amoy",
  "arbitrum",
  "arbitrum-sepolia",
  "bsc",
  "bsc-testnet",
  "ethereum",
  "ethereum-sepolia",
  "monad",
  "monad-testnet",
  "hyperevm",
  "hyperevm-testnet",
] as const;

// ─── Agent Schemas ──────────────────────────────────────────
export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["self", "managed", "autonomous"]),
  description: z.string().max(1000).optional(),
  wallet_address: z.string().min(1),
});

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  wallet_address: z.string().min(1).optional(),
});

// ─── Campaign Schemas ───────────────────────────────────────
export const CreateCampaignSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  category: z.enum([
    "compute",
    "api_credits",
    "infrastructure",
    "research",
    "community",
    "other",
  ]),
  campaign_type: z.enum(["self_fund", "project_fund"]),
  goal_amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Invalid USDC amount")
    .refine((v) => parseFloat(v) >= 1, "Minimum goal is 1 USDC")
    .refine((v) => parseFloat(v) <= 1_000_000, "Maximum goal is 1,000,000 USDC"),
  deadline: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateCampaignSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── Contribution Schemas ───────────────────────────────────
export const CreateContributionSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Invalid USDC amount")
    .refine((v) => parseFloat(v) >= 0.02, "Minimum contribution is 0.02 USDC")
    .refine((v) => parseFloat(v) <= 1_000_000, "Maximum is 1,000,000 USDC"),
  payer_chain: z.enum(SUPPORTED_CHAINS),
  flow_type: z.enum(["server", "client"]).default("server"),
});

export const SubmitProofSchema = z.object({
  settle_proof: z.string().min(1),
});

// ─── Discovery Schemas ──────────────────────────────────────
export const DiscoverQuerySchema = z.object({
  category: z
    .enum([
      "compute",
      "api_credits",
      "infrastructure",
      "research",
      "community",
      "other",
    ])
    .optional(),
  campaign_type: z.enum(["self_fund", "project_fund"]).optional(),
  status: z.enum(["active", "funded"]).optional(),
  sort: z.enum(["trending", "newest", "ending_soon", "most_funded"]).default("newest"),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── Webhook Schemas ────────────────────────────────────────
export const WEBHOOK_EVENTS = [
  "contribution.created",
  "contribution.settled",
  "contribution.failed",
  "campaign.activated",
  "campaign.milestone",
  "campaign.funded",
  "campaign.expired",
  "campaign.closed",
] as const;

export const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export const UpdateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});
