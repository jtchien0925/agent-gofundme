/**
 * Global error handler — returns consistent JSON error responses
 */

import type { Context } from "hono";
import { CampaignError } from "../services/campaign.service";
import { ContributionError } from "../services/contribution.service";
import { WebhookError } from "../services/webhook.service";
import { PaymentError } from "../services/payment.service";
import { ZodError } from "zod";

export function handleError(err: Error, c: Context) {
  // Zod validation errors
  if (err instanceof ZodError) {
    return c.json(
      {
        ok: false,
        error: "Validation error",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
      400
    );
  }

  // Domain errors with status codes
  if (
    err instanceof CampaignError ||
    err instanceof ContributionError ||
    err instanceof WebhookError
  ) {
    return c.json(
      { ok: false, error: err.message },
      err.statusCode as 400 | 401 | 403 | 404 | 500
    );
  }

  // AgentPay errors
  if (err instanceof PaymentError) {
    return c.json(
      {
        ok: false,
        error: "Payment processing error",
        message: err.message,
      },
      err.statusCode >= 500 ? 502 : (err.statusCode as 400 | 401 | 402 | 429)
    );
  }

  // Unknown errors
  console.error("Unhandled error:", err);
  return c.json(
    { ok: false, error: "Internal server error" },
    500
  );
}
