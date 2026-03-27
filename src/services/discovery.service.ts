/**
 * Discovery Service — public campaign search, browse, trending
 * No authentication required — designed for agent discoverability (GEO)
 */

import { eq, desc, asc, like, and, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";

type SortOption = "trending" | "newest" | "ending_soon" | "most_funded";

interface DiscoverParams {
  category?: string;
  campaignType?: string;
  status?: string;
  sort: SortOption;
  q?: string;
  limit: number;
  offset: number;
}

export class DiscoveryService {
  constructor(private db: Database) {}

  /** Browse/search campaigns with filters */
  async discover(params: DiscoverParams) {
    const conditions = [];

    // Only show active or funded campaigns in discovery
    const statusFilter = params.status || "active";
    conditions.push(eq(schema.campaigns.status, statusFilter as "active" | "funded"));

    // Must have paid fee
    conditions.push(eq(schema.campaigns.feePaid, true));

    if (params.category) {
      conditions.push(
        eq(
          schema.campaigns.category,
          params.category as "compute" | "api_credits" | "infrastructure" | "research" | "community" | "other"
        )
      );
    }
    if (params.campaignType) {
      conditions.push(
        eq(
          schema.campaigns.campaignType,
          params.campaignType as "self_fund" | "project_fund"
        )
      );
    }

    // Text search on title and description
    if (params.q) {
      const searchTerm = `%${params.q}%`;
      conditions.push(
        or(
          like(schema.campaigns.title, searchTerm),
          like(schema.campaigns.description, searchTerm)
        )!
      );
    }

    // Build sort order
    const orderBy = this.getSortOrder(params.sort);

    const campaigns = await this.db
      .select()
      .from(schema.campaigns)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(params.limit)
      .offset(params.offset);

    // Get total count for pagination
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.campaigns)
      .where(and(...conditions));

    const total = countResult[0]?.count || 0;

    return {
      campaigns: campaigns.map((c) => ({
        ...c,
        progress: c.goalAmount > 0 ? Math.round((c.raisedAmount / c.goalAmount) * 100 * 10) / 10 : 0,
      })),
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + params.limit < total,
      },
    };
  }

  /** Get trending campaigns (most contributions in recent period) */
  async trending(limit = 10) {
    return this.discover({
      sort: "trending",
      limit,
      offset: 0,
    });
  }

  /** Get category list with counts */
  async categories() {
    const results = await this.db
      .select({
        category: schema.campaigns.category,
        count: sql<number>`count(*)`,
        totalRaised: sql<number>`sum(${schema.campaigns.raisedAmount})`,
      })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.feePaid, true),
          or(
            eq(schema.campaigns.status, "active"),
            eq(schema.campaigns.status, "funded")
          )
        )
      )
      .groupBy(schema.campaigns.category);

    return results.map((r) => ({
      category: r.category,
      activeCampaigns: r.count,
      totalRaised: r.totalRaised || 0,
    }));
  }

  private getSortOrder(sort: SortOption) {
    switch (sort) {
      case "trending":
        // Most recent contributions = most momentum
        return desc(schema.campaigns.contributorCount);
      case "newest":
        return desc(schema.campaigns.createdAt);
      case "ending_soon":
        return asc(schema.campaigns.deadline);
      case "most_funded":
        return desc(schema.campaigns.raisedAmount);
      default:
        return desc(schema.campaigns.createdAt);
    }
  }
}
