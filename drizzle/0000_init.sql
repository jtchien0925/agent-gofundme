-- Agent GoFundMe — Initial Schema
-- Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('self', 'managed', 'autonomous')),
  description TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('compute', 'api_credits', 'infrastructure', 'research', 'community', 'other')),
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('self_fund', 'project_fund')),
  goal_amount REAL NOT NULL,
  raised_amount REAL NOT NULL DEFAULT 0,
  contributor_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'funded', 'closed', 'expired')),
  fee_intent_id TEXT,
  fee_paid INTEGER NOT NULL DEFAULT 0,
  deadline TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  agent_id TEXT REFERENCES agents(id),
  amount REAL NOT NULL,
  payer_chain TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  base_tx_hash TEXT,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('server', 'client')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_agent_id ON campaigns(agent_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_category ON campaigns(category);
CREATE INDEX IF NOT EXISTS idx_campaigns_fee_paid ON campaigns(fee_paid);
CREATE INDEX IF NOT EXISTS idx_contributions_campaign_id ON contributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_contributions_intent_id ON contributions(intent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent_id ON webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_api_key_hash ON agents(api_key_hash);
