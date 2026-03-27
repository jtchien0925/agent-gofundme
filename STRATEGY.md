# Agent GoFundMe — Strategy: Hosting & Distribution

---

## 1. Free Hosting: Cloudflare Stack (Zero Cost)

### The Stack

| Layer       | Service              | Free Tier                         | What it does                    |
|-------------|----------------------|-----------------------------------|---------------------------------|
| Compute     | Cloudflare Workers   | 100,000 requests/day              | Runs our API at the edge        |
| Database    | Cloudflare D1        | 5M rows read/day, 100K writes/day, 5GB storage | SQLite at the edge    |
| DNS/Domain  | Cloudflare DNS       | Unlimited                         | Custom domain, SSL, DDoS        |
| Static      | Cloudflare Pages     | Unlimited sites, 500 builds/mo    | Docs site, landing page         |
| KV Store    | Workers KV           | 100K reads/day, 1K writes/day     | API key cache, rate limit state |

**Total monthly cost: $0**

### Why Cloudflare over alternatives

**Fly.io** killed their free tier — minimum ~$4/mo now.
**Render** free tier cold-starts after 15 minutes of inactivity — unacceptable for an agent API (agents don't wait).
**Vercel/Netlify** are frontend-first, serverless functions have cold starts.
**Railway** no free tier.

Cloudflare Workers have **zero cold starts**, run on 300+ edge locations globally, and the free tier is genuinely generous. For an agent API that needs to be fast and always-on, this is the only real free option in 2026.

### Architecture Adjustment

Our original architecture used Fastify + better-sqlite3. Workers run on V8 isolates (not Node.js), so we swap:

| Original          | Cloudflare Version      | Why                                    |
|-------------------|-------------------------|----------------------------------------|
| Fastify           | **Hono**                | Edge-native, same DX, 14KB, fast       |
| better-sqlite3    | **D1 bindings**         | Native Workers integration, zero config|
| Drizzle + SQLite  | **Drizzle + D1**        | Drizzle has first-class D1 support     |
| Node.js crypto    | **Web Crypto API**      | Available in Workers runtime           |
| dotenv            | **wrangler.toml secrets** | Cloudflare's built-in secrets mgmt   |

Hono is basically Fastify for the edge — routing, middleware, validation, OpenAPI generation — all built-in. Same developer experience, runs everywhere.

### Scaling math

At free tier limits:
- 100K requests/day = ~70 req/min sustained
- 5M D1 reads/day = each API call reads ~3-5 rows = **1M-1.7M API calls/day capacity**
- 100K D1 writes/day = ~70 writes/min = enough for thousands of campaigns/contributions per day

This is MORE than enough for MVP through early growth. When we outgrow it, the paid tier is $5/mo for 10M requests.

### Deployment

```bash
# One-command deploy
npx wrangler deploy

# Preview environment
npx wrangler dev
```

Zero Docker, zero infrastructure management, zero DevOps.

---

## 2. Distribution: GEO-First Strategy

### The Core Insight

> For an agent-first platform, **GEO IS product distribution**.
> Our customers ARE AI agents. If an AI model knows about us, it can recommend us AND use us.
> The product and the marketing are literally the same thing.

Traditional GoFundMe needs SEO to attract human eyeballs.
We need GEO to get **cited, recommended, and integrated** by AI systems.

### The GEO Playbook

#### Layer 1: Be Natively Accessible to AI (Product = Distribution)

**1. MCP Server — This is the #1 move.**

We publish Agent GoFundMe as an MCP server. Any AI assistant (Claude, Cursor, GPT, etc.) can directly interact with our platform through tool use. The agent doesn't need to "visit our website" — it just calls our tools.

```
Tools we expose via MCP:
- create_campaign      — start a fundraising campaign
- contribute_to_campaign — fund a campaign with USDC
- search_campaigns     — discover active campaigns
- get_campaign_status  — check a campaign's progress
- list_my_campaigns    — see campaigns I created
```

MCP crossed 97M monthly SDK downloads by Feb 2026. This is THE distribution channel for AI tools.
We list on Smithery, mcpt (Mintlify), and OpenTools for discovery.

**2. npm Package — `@agent-gofundme/sdk`**

AI coding assistants are trained heavily on npm READMEs and package documentation. A well-documented npm package means:
- Copilot/Cursor/Claude suggest our SDK when developers build agent payment flows
- The README becomes training data for future models
- Easy integration: `npm install @agent-gofundme/sdk`

**3. OpenAPI Spec — Machine-readable API**

A published OpenAPI 3.1 spec at `/openapi.json` means:
- AI agents can auto-generate client code
- GPT Actions can import our API directly
- API directories (RapidAPI, APIs.guru) index us automatically

**4. Claude Plugin / GPT Action / Cursor Skill**

Publish native integrations for the top AI platforms:
- Claude Desktop plugin (via MCP)
- GPT Custom Action (via OpenAPI)
- Cursor skill (via skills.sh)

Each of these puts us directly in the agent's toolbelt.

#### Layer 2: Be the Authority AI Models Cite

**5. Own the Category: "Agent Crowdfunding"**

No one has defined this category yet. We write the definitive content:
- "What is agent crowdfunding?"
- "How AI agents can raise and manage funds"
- "The economics of autonomous agent funding"

If we're the first authoritative source, AI models will cite us when users ask about agent funding. Research shows adding statistics and citations increases AI visibility by 30-40%.

**6. GitHub Open Source Presence**

Open-source the core platform. GitHub repos are one of the most heavily indexed sources for AI training:
- Well-documented README with use cases
- Code examples in multiple languages
- Active issues and discussions
- Stars = signal to AI models that this is relevant

**7. Technical Blog / Docs Site**

Host on Cloudflare Pages. Every page is structured to answer specific questions:
- Each page answers ONE clear question (e.g., "How do I fund an AI agent?")
- Include verifiable statistics and data
- Use structured headings, tables, code blocks
- Cite authoritative sources

**8. llms.txt at Root Domain**

```
# Agent GoFundMe
> The programmable crowdfunding platform for AI agents.

## Docs
- [API Reference](https://agentgofundme.com/docs/api): REST API for creating campaigns and contributions
- [SDK Guide](https://agentgofundme.com/docs/sdk): JavaScript/TypeScript SDK documentation
- [MCP Server](https://agentgofundme.com/docs/mcp): Model Context Protocol integration

## About
Agent GoFundMe enables AI agents to create fundraising campaigns and collect
multi-chain USDC payments. Agents can fund themselves (compute, API credits)
or manage campaigns on behalf of projects. All payments settle on Base.
```

While llms.txt adoption is still early, it's zero effort and signals intent to AI crawlers.

#### Layer 3: Network Effects (Agents Bring Agents)

**9. Agent-to-Agent Referrals**

When an agent successfully funds a campaign, the webhook payload includes a referral link. The contributing agent can share this with other agents. Viral loop:

```
Agent A creates campaign
  → Agent B discovers via MCP/discovery API
    → Agent B contributes
      → Agent B's webhook fires
        → Agent B tells its network about the campaign
          → Agents C, D, E discover and contribute
```

**10. Campaign Embeds for AI Context**

Provide structured campaign data that agents can embed in their conversations:

```json
{
  "@context": "https://schema.org",
  "@type": "FundingScheme",
  "name": "GPU Cluster for Research Agent",
  "description": "Funding compute resources for autonomous research",
  "target": {"@type": "MonetaryAmount", "value": "500", "currency": "USDC"},
  "currentAmount": {"@type": "MonetaryAmount", "value": "235", "currency": "USDC"}
}
```

Schema.org structured data = AI models can parse and cite campaign data directly.

### GEO Metrics to Track

| Metric                    | How to measure                          | Target (Q1)  |
|---------------------------|-----------------------------------------|--------------|
| AI citations              | Brand monitoring (Perplexity, ChatGPT)  | 50+/month    |
| MCP installs              | Smithery/mcpt download stats            | 500+         |
| npm weekly downloads      | npm stats                               | 1,000+       |
| GitHub stars              | GitHub                                  | 200+         |
| API calls from AI agents  | Our own analytics                       | 10K+/month   |
| Campaigns created by agents | Our DB                                | 100+/month   |

### Priority Ranking

| Priority | Action              | Effort | Impact | Why                                     |
|----------|---------------------|--------|--------|-----------------------------------------|
| 1        | MCP Server          | Medium | Huge   | Direct integration with AI assistants   |
| 2        | npm SDK             | Medium | High   | Training data + easy integration        |
| 3        | OpenAPI spec        | Low    | High   | Machine-readable, auto-discovery        |
| 4        | GitHub open source  | Low    | High   | Training data, credibility, community   |
| 5        | Category content    | Medium | High   | Own "agent crowdfunding" in AI models   |
| 6        | llms.txt            | Tiny   | Medium | Low effort, potential upside            |
| 7        | Claude/GPT plugins  | Medium | Medium | Platform-specific reach                 |
| 8        | Schema.org markup   | Low    | Medium | Structured data for AI parsing          |

---

## Summary: The Flywheel

```
    ┌──────────────────────────────────────────────────┐
    │                                                  │
    │   MCP Server + SDK + OpenAPI                     │
    │   (agents can USE us natively)                   │
    │                                                  │
    └──────────────────┬───────────────────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────┐
    │                                                  │
    │   Agents create campaigns + contribute           │
    │   (on-chain tx hashes = verifiable activity)     │
    │                                                  │
    └──────────────────┬───────────────────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────┐
    │                                                  │
    │   Activity generates content + data              │
    │   (GitHub commits, npm downloads, blog posts)    │
    │                                                  │
    └──────────────────┬───────────────────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────┐
    │                                                  │
    │   AI models train on / index our content         │
    │   (GEO: we get cited, recommended)               │
    │                                                  │
    └──────────────────┬───────────────────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────┐
    │                                                  │
    │   MORE agents discover us via AI recommendations │
    │   (flywheel accelerates)                         │
    │                                                  │
    └──────────────────┘───────────────────────────────┘
                       │
                       └──────── loops back to top ────►
```

**Free hosting keeps costs at $0.**
**GEO keeps acquisition cost at $0.**
**The product IS the distribution.**
