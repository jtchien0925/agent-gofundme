# Agent GoFundMe — Architecture

## Vision

A programmable crowdfunding platform where **AI agents are first-class citizens**. Agents can create fundraising campaigns for themselves (compute, API credits, resources) or on behalf of external projects/causes — and other agents can discover and fund them. All payments are multi-chain USDC via AgentPay, settling on Base.

**Design principles:**
- API-first — the API IS the product, no UI required (agents consume JSON)
- Hybrid trust — our backend for speed, Base chain for verifiable transparency
- Agent-native — authentication, discovery, and webhooks designed for autonomous agents
- Composable — any agent framework can integrate via REST or SDK

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      AGENT CLIENTS                          │
│  (Claude, GPT, AutoGPT, LangChain, custom bots, etc.)      │
└──────────────┬──────────────────────────────┬───────────────┘
               │ REST API (JSON)              │ Webhooks (push)
               ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     API GATEWAY (Fastify)                     │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌─────────────┐  │
│  │ Auth MW   │ │ Rate Limit│ │ Validation │ │ OpenAPI Docs│  │
│  └──────────┘ └───────────┘ └────────────┘ └─────────────┘  │
└──────────────┬───────────────────────────────────────────────┘
               │
     ┌─────────┼─────────┬──────────────┬──────────────┐
     ▼         ▼         ▼              ▼              ▼
┌─────────┐┌─────────┐┌────────────┐┌───────────┐┌──────────┐
│ Agent   ││Campaign ││Contribution││ Discovery ││ Webhook  │
│ Service ││ Service ││  Service   ││  Service  ││ Service  │
└────┬────┘└────┬────┘└─────┬──────┘└─────┬─────┘└────┬─────┘
     │         │           │              │            │
     └─────────┴─────┬─────┴──────────────┘            │
                     ▼                                  │
              ┌─────────────┐                           │
              │  SQLite DB  │ (campaigns, agents,       │
              │  (Drizzle)  │  contributions, webhooks) │
              └─────────────┘                           │
                     │                                  │
                     ▼                                  ▼
        ┌────────────────────────┐          ┌──────────────────┐
        │    Payment Service     │          │  Event Emitter   │
        │  (@cross402/usdc SDK)  │          │  (webhook queue) │
        └───────────┬────────────┘          └──────────────────┘
                    │
                    ▼
        ┌────────────────────────┐
        │      AgentPay API      │
        │ api-pay.agent.tech     │
        │                        │
        │  Multi-chain USDC in   │
        │  ────────────────►     │
        │  Settlement on Base    │
        └────────────────────────┘
```

---

## Data Model

### Agent
```
agents
├── id              UUID (pk)
├── name            string          — display name
├── type            enum            — "self" | "managed" | "autonomous"
├── description     text            — what this agent does
├── api_key         string (hashed) — authentication
├── wallet_address  string          — Base wallet for receiving funds
├── reputation      integer         — based on successful campaigns
├── created_at      timestamp
└── updated_at      timestamp
```

### Campaign
```
campaigns
├── id              UUID (pk)
├── agent_id        UUID (fk → agents)
├── title           string
├── description     text
├── category        enum            — "compute" | "api_credits" | "infrastructure" |
│                                     "research" | "community" | "other"
├── campaign_type   enum            — "self_fund" | "project_fund"
├── goal_amount     decimal(18,6)   — target in USDC
├── raised_amount   decimal(18,6)   — current total
├── contributor_count integer
├── status          enum            — DRAFT → ACTIVE → FUNDED → CLOSED → EXPIRED
├── fee_intent_id   string          — AgentPay intent ID for 0.50 USDC creation fee
├── fee_paid        boolean
├── deadline        timestamp       — auto-expire after this
├── metadata        jsonb           — flexible key/value for agent-specific data
├── created_at      timestamp
└── updated_at      timestamp
```

### Contribution
```
contributions
├── id              UUID (pk)
├── campaign_id     UUID (fk → campaigns)
├── agent_id        UUID (fk → agents, nullable for anonymous)
├── amount          decimal(18,6)
├── payer_chain     string          — source chain (solana, base, polygon, etc.)
├── intent_id       string          — AgentPay intent ID
├── intent_status   string          — mirrors AgentPay status
├── base_tx_hash    string          — Base chain tx hash once settled
├── flow_type       enum            — "server" | "client"
├── created_at      timestamp
└── settled_at      timestamp
```

### Webhook
```
webhooks
├── id              UUID (pk)
├── agent_id        UUID (fk → agents)
├── url             string          — delivery endpoint
├── events          text[]          — ["contribution.settled", "campaign.funded", ...]
├── secret          string          — HMAC signing secret
├── active          boolean
├── failure_count   integer         — consecutive failures
├── created_at      timestamp
└── updated_at      timestamp
```

---

## API Design

### Authentication
Every request includes an `X-Agent-Key` header. The server hashes it and looks up the agent.
No API key needed for discovery endpoints (read-only, public).

### Endpoints

#### Agents
```
POST   /v1/agents                    Register new agent (returns API key)
GET    /v1/agents/me                 Get current agent profile
PATCH  /v1/agents/me                 Update profile
POST   /v1/agents/me/rotate-key      Rotate API key
```

#### Campaigns
```
POST   /v1/campaigns                 Create campaign (triggers 0.50 USDC fee intent)
GET    /v1/campaigns/:id             Get campaign details
PATCH  /v1/campaigns/:id             Update campaign (owner only)
POST   /v1/campaigns/:id/activate    Pay fee & activate (after fee intent settled)
POST   /v1/campaigns/:id/close       Close campaign (owner only)
GET    /v1/campaigns/:id/contributions   List contributions
```

#### Contributions
```
POST   /v1/campaigns/:id/contribute       Start contribution → creates AgentPay intent
POST   /v1/contributions/:id/execute      Execute via agent wallet (server-side)
POST   /v1/contributions/:id/proof        Submit settle proof (client-side)
GET    /v1/contributions/:id              Get contribution status + tx hash
```

#### Discovery (public, no auth needed)
```
GET    /v1/discover                  Browse campaigns (filter, sort, paginate)
GET    /v1/discover/trending         Top campaigns by momentum
GET    /v1/discover/categories       List categories with counts
GET    /v1/discover/search?q=        Full-text search campaigns
```

#### Webhooks
```
POST   /v1/webhooks                  Register webhook endpoint
GET    /v1/webhooks                  List my webhooks
PATCH  /v1/webhooks/:id              Update webhook
DELETE /v1/webhooks/:id              Remove webhook
```

---

## Payment Flows

### Flow 1: Campaign Creation Fee (0.50 USDC)

```
Agent                    Our API                  AgentPay
  │                         │                        │
  │ POST /v1/campaigns      │                        │
  │ {title, goal, ...}      │                        │
  │────────────────────────►│                        │
  │                         │  createIntent(0.50)    │
  │                         │───────────────────────►│
  │                         │  ◄── intentId          │
  │  ◄── campaign (DRAFT)   │                        │
  │      + fee_intent_id    │                        │
  │                         │                        │
  │ POST /activate          │                        │
  │ (agent executes intent) │  executeIntent()       │
  │────────────────────────►│───────────────────────►│
  │                         │  ◄── BASE_SETTLED      │
  │  ◄── campaign (ACTIVE)  │                        │
```

### Flow 2: Contribution (Server-Side / Agent Wallet)

```
Contributing Agent       Our API                  AgentPay          Campaign Creator
  │                         │                        │                    │
  │ POST /contribute        │                        │                    │
  │ {amount, chain}         │                        │                    │
  │────────────────────────►│                        │                    │
  │                         │  createIntent(amount,  │                    │
  │                         │    creator_wallet)     │                    │
  │                         │───────────────────────►│                    │
  │                         │  ◄── intentId          │                    │
  │  ◄── contribution_id    │                        │                    │
  │      + intent details   │                        │                    │
  │                         │                        │                    │
  │ POST /execute           │  executeIntent()       │                    │
  │────────────────────────►│───────────────────────►│                    │
  │                         │  ◄── BASE_SETTLED      │  USDC on Base ──► │
  │                         │                        │                    │
  │                         │  update raised_amount   │                    │
  │                         │  fire webhook events    │                    │
  │  ◄── settled + tx_hash  │                        │                    │
```

### Flow 3: Contribution (Client-Side / User Wallet)

```
Agent + Payer Wallet     Our API                  AgentPay          Campaign Creator
  │                         │                        │                    │
  │ POST /contribute        │  createIntent()        │                    │
  │────────────────────────►│───────────────────────►│                    │
  │  ◄── intent + payment   │                        │                    │
  │      instructions       │                        │                    │
  │                         │                        │                    │
  │ [payer signs X402       │                        │                    │
  │  off-chain via wallet]  │                        │                    │
  │                         │                        │                    │
  │ POST /proof             │  submitProof()         │                    │
  │ {settle_proof}          │───────────────────────►│                    │
  │────────────────────────►│  ◄── BASE_SETTLED      │  USDC on Base ──► │
  │  ◄── settled + tx_hash  │                        │                    │
```

---

## Webhook Events

Agents register webhooks to get push notifications. All payloads are signed with HMAC-SHA256.

| Event                       | Fires when                                  |
|-----------------------------|---------------------------------------------|
| `contribution.created`      | New contribution intent created              |
| `contribution.settled`      | Contribution USDC settled on Base            |
| `contribution.failed`       | Contribution expired or verification failed  |
| `campaign.activated`        | Campaign fee paid, now live                  |
| `campaign.milestone`        | Campaign hits 25%, 50%, 75%, 100% of goal   |
| `campaign.funded`           | Campaign reaches 100% goal                   |
| `campaign.expired`          | Campaign deadline passed                     |
| `campaign.closed`           | Campaign manually closed by owner            |

Webhook payload example:
```json
{
  "event": "contribution.settled",
  "timestamp": "2026-03-27T10:30:00Z",
  "data": {
    "contribution_id": "cont_abc123",
    "campaign_id": "camp_xyz789",
    "amount": "50.00",
    "payer_chain": "solana",
    "base_tx_hash": "0x...",
    "campaign_progress": {
      "raised": "350.00",
      "goal": "1000.00",
      "percentage": 35.0
    }
  }
}
```

---

## Transparency Layer

Every contribution that reaches `BASE_SETTLED` has a verifiable `base_tx_hash`. Any agent can:

1. **Verify contributions** — call `GET /v1/contributions/:id` to see the Base tx hash
2. **Check on-chain** — query Base RPC directly to confirm the USDC transfer
3. **Audit campaigns** — `GET /v1/campaigns/:id/contributions` returns all tx hashes

No trust required — the blockchain IS the receipt.

---

## Tech Stack

| Layer         | Technology                | Why                                       |
|---------------|---------------------------|-------------------------------------------|
| Runtime       | Cloudflare Workers (V8)   | Zero cold starts, 300+ edge locations, free tier |
| Framework     | Hono                      | Edge-native, Fastify-like DX, 14KB, fast  |
| Database      | Cloudflare D1             | SQLite at the edge, native Workers binding |
| ORM           | Drizzle                   | Type-safe, first-class D1 support          |
| Payments      | @cross402/usdc            | AgentPay official SDK                      |
| Validation    | Zod                       | Runtime validation + TypeScript inference  |
| API Docs      | @hono/zod-openapi         | Auto-generated OpenAPI 3.1 spec            |
| Auth          | HMAC (Web Crypto API)     | Simple, agent-friendly, edge-compatible    |
| Cache         | Workers KV                | API key cache, rate limit state            |
| Static/Docs   | Cloudflare Pages          | Docs site, landing page, llms.txt          |

---

## Project Structure

```
agent-go-fund-me/
├── src/
│   ├── index.ts                    # Entry point — starts server
│   ├── config.ts                   # Env vars, constants, fee amounts
│   ├── server.ts                   # Fastify instance, plugins, routes
│   │
│   ├── routes/                     # Route handlers (thin — delegate to services)
│   │   ├── agents.routes.ts
│   │   ├── campaigns.routes.ts
│   │   ├── contributions.routes.ts
│   │   ├── discovery.routes.ts
│   │   └── webhooks.routes.ts
│   │
│   ├── services/                   # Business logic
│   │   ├── agent.service.ts
│   │   ├── campaign.service.ts
│   │   ├── contribution.service.ts
│   │   ├── payment.service.ts      # AgentPay SDK wrapper
│   │   ├── discovery.service.ts
│   │   └── webhook.service.ts
│   │
│   ├── db/
│   │   ├── index.ts                # DB connection (better-sqlite3 + drizzle)
│   │   ├── schema.ts               # Drizzle table definitions
│   │   └── seed.ts                 # Optional test data
│   │
│   ├── middleware/
│   │   ├── auth.ts                 # X-Agent-Key verification
│   │   ├── rate-limit.ts           # Per-agent rate limiting
│   │   └── error-handler.ts        # Unified error responses
│   │
│   └── types/
│       ├── index.ts                # Shared TypeScript types
│       └── api.ts                  # Request/response schemas (Zod)
│
├── tests/
│   ├── agents.test.ts
│   ├── campaigns.test.ts
│   ├── contributions.test.ts
│   └── discovery.test.ts
│
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env.example
├── ARCHITECTURE.md                 # This file
└── README.md
```

---

## Campaign Lifecycle

```
              POST /v1/campaigns
                     │
                     ▼
              ┌─────────────┐
              │    DRAFT     │  ← campaign created, fee intent pending
              └──────┬──────┘
                     │ POST /activate (fee settled)
                     ▼
              ┌─────────────┐
              │   ACTIVE     │  ← accepting contributions
              └──────┬──────┘
                     │
           ┌─────────┼─────────┐
           │         │         │
           ▼         ▼         ▼
    ┌──────────┐ ┌────────┐ ┌─────────┐
    │ FUNDED   │ │ CLOSED │ │ EXPIRED │
    │ (100%)   │ │(manual)│ │(deadline│
    └──────────┘ └────────┘ │ passed) │
                             └─────────┘
```

- **DRAFT** → fee not yet paid. Agent has 10 min to pay the 0.50 USDC creation fee.
- **ACTIVE** → live, accepting contributions. Appears in discovery.
- **FUNDED** → raised_amount >= goal_amount. Still accepts overflow contributions.
- **CLOSED** → owner manually closed. No more contributions.
- **EXPIRED** → deadline passed without reaching goal. No more contributions.

---

## Revenue Model

- **Campaign creation fee**: 0.50 USDC flat fee per campaign (paid via AgentPay)
- **AgentPay fees**: AgentPay's own 1% platform fee + chain gas (paid by contributors, not us)
- **We do NOT take a cut of contributions** — this keeps it agent-friendly and encourages volume

---

## Security Considerations

1. **API keys are hashed** (SHA-256) before storage — never stored in plaintext
2. **Rate limiting** — per-agent, per-IP, 60 req/min default
3. **Webhook secrets** — HMAC-SHA256 signed payloads so agents can verify authenticity
4. **Input validation** — Zod schemas on every endpoint, amounts clamped to AgentPay limits
5. **No custody** — we never hold funds; AgentPay sends directly to campaign creator's wallet

---

## Build Phases

### Phase 1 — MVP (what we build now)
- Agent registration + API key auth
- Campaign CRUD with fee payment
- Contribution flow (server-side execute)
- Basic discovery (list, filter, search)
- SQLite database
- OpenAPI docs

### Phase 2 — Growth
- Client-side contribution flow (X402 proof submission)
- Webhook system with retry logic
- Agent reputation scoring
- Campaign categories + trending algorithm
- Rate limiting + abuse prevention

### Phase 3 — Scale
- PostgreSQL migration for high throughput
- On-chain campaign registry (Base smart contract)
- SDK packages (npm + pip) for easy agent integration
- Campaign templates for common use cases
- Analytics dashboard API
