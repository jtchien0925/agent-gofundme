import type { Env } from "./types";

export function getConfig(env: Env) {
  return {
    agentPay: {
      baseUrl: env.AGENTPAY_BASE_URL || "https://api-pay.agent.tech",
      apiKey: env.AGENTPAY_API_KEY,
      secretKey: env.AGENTPAY_SECRET_KEY,
    },
    platform: {
      wallet: env.PLATFORM_WALLET,
      campaignFeeUsdc: env.CAMPAIGN_FEE_USDC || "0.50",
    },
    environment: env.ENVIRONMENT || "production",
  };
}
