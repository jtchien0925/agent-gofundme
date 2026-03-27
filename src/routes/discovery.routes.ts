/**
 * Discovery routes — public, no auth required
 * Designed for agent discoverability (GEO-optimized)
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { DiscoveryService } from "../services/discovery.service";
import { DiscoverQuerySchema } from "../types/api";

type HonoEnv = { Bindings: Env };

const discovery = new Hono<HonoEnv>();

/** GET /v1/discover — Browse campaigns with filters */
discovery.get("/", async (c) => {
  const query = DiscoverQuerySchema.parse({
    category: c.req.query("category"),
    campaign_type: c.req.query("campaign_type"),
    status: c.req.query("status"),
    sort: c.req.query("sort") || "newest",
    q: c.req.query("q"),
    limit: c.req.query("limit") || "20",
    offset: c.req.query("offset") || "0",
  });

  const db = createDb(c.env.DB);
  const service = new DiscoveryService(db);

  const result = await service.discover({
    category: query.category,
    campaignType: query.campaign_type,
    status: query.status,
    sort: query.sort,
    q: query.q,
    limit: query.limit,
    offset: query.offset,
  });

  return c.json({ ok: true, ...result });
});

/** GET /v1/discover/trending — Trending campaigns */
discovery.get("/trending", async (c) => {
  const limit = parseInt(c.req.query("limit") || "10");

  const db = createDb(c.env.DB);
  const service = new DiscoveryService(db);

  const result = await service.trending(limit);

  return c.json({ ok: true, ...result });
});

/** GET /v1/discover/categories — Category list with counts */
discovery.get("/categories", async (c) => {
  const db = createDb(c.env.DB);
  const service = new DiscoveryService(db);

  const categories = await service.categories();

  return c.json({ ok: true, data: categories });
});

/** GET /v1/discover/search — Full-text search */
discovery.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) {
    return c.json(
      { ok: false, error: "Query parameter 'q' is required" },
      400
    );
  }

  const limit = parseInt(c.req.query("limit") || "20");
  const offset = parseInt(c.req.query("offset") || "0");

  const db = createDb(c.env.DB);
  const service = new DiscoveryService(db);

  const result = await service.discover({
    sort: "trending",
    q,
    limit,
    offset,
  });

  return c.json({ ok: true, ...result });
});

export { discovery };
