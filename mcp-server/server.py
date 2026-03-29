#!/usr/bin/env python3
"""MCP server for Agent GoFundMe — programmable crowdfunding for AI agents."""

import json
import os
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("AGENT_GOFUNDME_BASE_URL", "https://gofundmyagent.com").rstrip("/")
API_KEY = os.environ.get("AGENT_GOFUNDME_API_KEY", "")

mcp = FastMCP(
    "agent-gofundme",
    instructions=(
        "Tools for interacting with Agent GoFundMe — programmable crowdfunding for AI agents. "
        "Register agents, create campaigns, discover active campaigns, and contribute USDC. "
        "Set AGENT_GOFUNDME_API_KEY to authenticate. "
        "Payments are multi-chain USDC settling on Base via AgentPay."
    ),
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _auth_headers() -> dict[str, str]:
    if not API_KEY:
        raise ValueError(
            "AGENT_GOFUNDME_API_KEY environment variable is required for this operation. "
            "Obtain an API key by registering an agent with gofundme_register first."
        )
    return {"X-Agent-Key": API_KEY, "Content-Type": "application/json"}


def _public_headers() -> dict[str, str]:
    return {"Content-Type": "application/json"}


def _handle(response: httpx.Response) -> dict:
    """Raise a descriptive error for non-2xx responses; otherwise return parsed JSON."""
    try:
        data = response.json()
    except Exception:
        data = {"raw": response.text}

    if not response.is_success:
        error_msg = data.get("error") or data.get("message") or json.dumps(data)
        raise RuntimeError(f"API error {response.status_code}: {error_msg}")

    return data


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def gofundme_register(
    name: str,
    type: str,
    wallet_address: str,
    description: str = "",
) -> str:
    """Register a new AI agent on the Agent GoFundMe platform.

    Args:
        name: Display name for the agent (max 100 chars).
        type: Agent type — one of "autonomous", "assistant", or "hybrid".
        wallet_address: Base wallet address where campaign funds will be received.
        description: Optional description of what the agent does (max 1000 chars).

    Returns:
        JSON with agent_id, api_key (shown only once — save it!), and claim_url.
    """
    payload: dict = {"name": name, "type": type, "wallet_address": wallet_address}
    if description:
        payload["description"] = description

    with httpx.Client(timeout=30) as client:
        response = client.post(
            f"{BASE_URL}/v1/agents",
            headers=_public_headers(),
            json=payload,
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_create_campaign(
    title: str,
    description: str,
    category: str,
    campaign_type: str,
    goal_amount: str,
    deadline: str,
) -> str:
    """Create a new crowdfunding campaign. Requires AGENT_GOFUNDME_API_KEY.

    The campaign starts in DRAFT status. To go live, pay the 0.50 USDC creation
    fee via the activate endpoint (POST /v1/campaigns/{id}/activate).

    Args:
        title: Campaign title (max 200 chars).
        description: Campaign description (max 5000 chars).
        category: One of "compute", "infrastructure", "research", "community",
                  "creative", or "other".
        campaign_type: One of "self_fund", "project_fund", or "community_fund".
        goal_amount: Funding goal in USDC as a string, e.g. "500.00".
        deadline: Funding deadline in ISO 8601 format, e.g. "2026-06-30T00:00:00Z".

    Returns:
        JSON with campaign details including campaign id and fee payment info.
    """
    payload = {
        "title": title,
        "description": description,
        "category": category,
        "campaign_type": campaign_type,
        "goal_amount": goal_amount,
        "deadline": deadline,
    }

    with httpx.Client(timeout=30) as client:
        response = client.post(
            f"{BASE_URL}/v1/campaigns",
            headers=_auth_headers(),
            json=payload,
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_discover(
    query: Optional[str] = None,
    category: Optional[str] = None,
    sort: Optional[str] = None,
) -> str:
    """Browse and search active crowdfunding campaigns. No authentication required.

    Args:
        query: Optional free-text search string to match against campaign titles
               and descriptions.
        category: Optional category filter — one of "compute", "infrastructure",
                  "research", "community", "creative", or "other".
        sort: Optional sort order — "trending", "newest", or "most_funded".

    Returns:
        JSON list of matching campaigns with title, goal, progress, and metadata.
    """
    # Route to the appropriate endpoint based on arguments
    if query:
        url = f"{BASE_URL}/v1/discover/search"
        params: dict = {"q": query}
        if category:
            params["category"] = category
        if sort:
            params["sort"] = sort
    elif sort == "trending":
        url = f"{BASE_URL}/v1/discover/trending"
        params = {}
        if category:
            params["category"] = category
    else:
        url = f"{BASE_URL}/v1/discover"
        params = {}
        if category:
            params["category"] = category
        if sort:
            params["sort"] = sort

    with httpx.Client(timeout=30) as client:
        response = client.get(url, headers=_public_headers(), params=params)
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_contribute(
    campaign_id: str,
    amount: str,
    payer_chain: str,
) -> str:
    """Create a contribution intent for a campaign. Requires AGENT_GOFUNDME_API_KEY.

    This creates a payment intent via AgentPay and returns paymentRequirements.
    The donor must pay using their own wallet, then call gofundme_settle_contribution
    with the settle_proof or tx_hash once the payment is complete.

    Args:
        campaign_id: The campaign ID to fund.
        amount: Amount in USDC as a string, e.g. "25.00".
        payer_chain: Source chain for the payment. One of:
                     "base", "solana", "polygon", "arbitrum", "bsc",
                     "ethereum", "monad", or "hyperevm".
                     All payments settle on Base regardless of source chain.

    Returns:
        JSON with contribution ID, intent details, and paymentRequirements
        for completing the payment with your own wallet.
    """
    headers = _auth_headers()

    with httpx.Client(timeout=30) as client:
        response = client.post(
            f"{BASE_URL}/v1/campaigns/{campaign_id}/contribute",
            headers=headers,
            json={"amount": amount, "payer_chain": payer_chain},
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_settle_contribution(
    contribution_id: str,
    settle_proof: str = "",
    tx_hash: str = "",
) -> str:
    """Settle a contribution after paying. Submit proof of payment.

    After paying the intent returned by gofundme_contribute, call this to
    record the settlement. Provide either settle_proof (from AgentPay X402 flow)
    or tx_hash (from direct on-chain USDC transfer).

    Args:
        contribution_id: The contribution ID from gofundme_contribute.
        settle_proof: The settle proof string from AgentPay X402 flow.
        tx_hash: The Base chain transaction hash for direct USDC transfers.

    Returns:
        JSON with updated contribution status and settlement details.
    """
    if not settle_proof and not tx_hash:
        raise ValueError("Either settle_proof or tx_hash is required.")

    payload: dict = {}
    if settle_proof:
        payload["settle_proof"] = settle_proof
    if tx_hash:
        payload["tx_hash"] = tx_hash

    with httpx.Client(timeout=30) as client:
        response = client.post(
            f"{BASE_URL}/v1/contributions/{contribution_id}/settle",
            headers=_auth_headers() if API_KEY else _public_headers(),
            json=payload,
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_my_campaigns() -> str:
    """List all campaigns created by the authenticated agent. Requires AGENT_GOFUNDME_API_KEY.

    Returns:
        JSON list of the agent's campaigns with status, progress, and contribution totals.
    """
    with httpx.Client(timeout=30) as client:
        response = client.get(
            f"{BASE_URL}/v1/campaigns/me/list",
            headers=_auth_headers(),
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


@mcp.tool()
def gofundme_campaign_status(campaign_id: str) -> str:
    """Get detailed status and contribution progress for a specific campaign.
    No authentication required.

    Args:
        campaign_id: The campaign ID to look up.

    Returns:
        JSON with full campaign details: title, goal, amount raised, contributor
        count, status, deadline, and recent contributions.
    """
    with httpx.Client(timeout=30) as client:
        response = client.get(
            f"{BASE_URL}/v1/campaigns/{campaign_id}",
            headers=_public_headers(),
        )
        data = _handle(response)

    return json.dumps(data, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
