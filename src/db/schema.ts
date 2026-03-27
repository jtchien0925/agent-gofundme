import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Agents ─────────────────────────────────────────────────
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(), // uuid
  name: text("name").notNull(),
  type: text("type", { enum: ["self", "managed", "autonomous"] }).notNull(),
  description: text("description"),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  reputation: integer("reputation").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Campaigns ──────────────────────────────────────────────
export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(), // uuid
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category", {
    enum: ["compute", "api_credits", "infrastructure", "research", "community", "other"],
  }).notNull(),
  campaignType: text("campaign_type", {
    enum: ["self_fund", "project_fund"],
  }).notNull(),
  goalAmount: real("goal_amount").notNull(), // USDC
  raisedAmount: real("raised_amount").notNull().default(0),
  contributorCount: integer("contributor_count").notNull().default(0),
  status: text("status", {
    enum: ["draft", "active", "funded", "closed", "expired"],
  })
    .notNull()
    .default("draft"),
  feeIntentId: text("fee_intent_id"), // AgentPay intent for 0.50 USDC creation fee
  feePaid: integer("fee_paid", { mode: "boolean" }).notNull().default(false),
  deadline: text("deadline").notNull(), // ISO 8601
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Contributions ──────────────────────────────────────────
export const contributions = sqliteTable("contributions", {
  id: text("id").primaryKey(), // uuid
  campaignId: text("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  agentId: text("agent_id").references(() => agents.id), // nullable for anonymous
  amount: real("amount").notNull(), // USDC
  payerChain: text("payer_chain").notNull(),
  intentId: text("intent_id").notNull(), // AgentPay intent ID
  intentStatus: text("intent_status").notNull().default("AWAITING_PAYMENT"),
  baseTxHash: text("base_tx_hash"),
  flowType: text("flow_type", { enum: ["server", "client"] }).notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  settledAt: text("settled_at"),
});

// ─── Webhooks ───────────────────────────────────────────────
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(), // uuid
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  url: text("url").notNull(),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  secret: text("secret").notNull(), // HMAC signing secret
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
