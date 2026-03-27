/**
 * Agent Service — registration, authentication, profile management
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { generateId, generateApiKey, sha256 } from "./crypto";

export class AgentService {
  constructor(private db: Database) {}

  /** Register a new agent. Returns the agent record + raw API key (only shown once). */
  async register(params: {
    name: string;
    type: "self" | "managed" | "autonomous";
    description?: string;
    walletAddress: string;
  }) {
    const id = generateId();
    const rawApiKey = generateApiKey();
    const apiKeyHash = await sha256(rawApiKey);

    await this.db.insert(schema.agents).values({
      id,
      name: params.name,
      type: params.type,
      description: params.description || null,
      apiKeyHash,
      walletAddress: params.walletAddress,
      reputation: 0,
    });

    const agent = await this.db.query.agents.findFirst({
      where: eq(schema.agents.id, id),
    });

    return {
      agent: this.sanitize(agent!),
      apiKey: rawApiKey, // Only returned on registration
    };
  }

  /** Authenticate an agent by API key. Returns agent or null. */
  async authenticate(apiKey: string) {
    const hash = await sha256(apiKey);
    const agent = await this.db.query.agents.findFirst({
      where: eq(schema.agents.apiKeyHash, hash),
    });
    return agent || null;
  }

  /** Get agent by ID */
  async getById(id: string) {
    const agent = await this.db.query.agents.findFirst({
      where: eq(schema.agents.id, id),
    });
    return agent ? this.sanitize(agent) : null;
  }

  /** Update agent profile */
  async update(
    id: string,
    params: {
      name?: string;
      description?: string;
      walletAddress?: string;
    }
  ) {
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (params.name) updates.name = params.name;
    if (params.description !== undefined) updates.description = params.description;
    if (params.walletAddress) updates.walletAddress = params.walletAddress;

    await this.db
      .update(schema.agents)
      .set(updates)
      .where(eq(schema.agents.id, id));

    return this.getById(id);
  }

  /** Rotate API key. Returns new raw key. */
  async rotateKey(id: string) {
    const rawApiKey = generateApiKey();
    const apiKeyHash = await sha256(rawApiKey);

    await this.db
      .update(schema.agents)
      .set({ apiKeyHash, updatedAt: new Date().toISOString() })
      .where(eq(schema.agents.id, id));

    return { apiKey: rawApiKey };
  }

  /** Increment agent reputation */
  async incrementReputation(id: string, amount: number = 1) {
    const agent = await this.db.query.agents.findFirst({
      where: eq(schema.agents.id, id),
    });
    if (!agent) return;

    await this.db
      .update(schema.agents)
      .set({
        reputation: agent.reputation + amount,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agents.id, id));
  }

  /** Remove sensitive fields before returning to API */
  private sanitize(agent: typeof schema.agents.$inferSelect) {
    const { apiKeyHash, ...safe } = agent;
    return safe;
  }
}
