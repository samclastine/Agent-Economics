import { createHash, timingSafeEqual } from 'crypto';

/**
 * Bearer-token authentication for the A423 workflow API.
 * Configure `A423_AGENT_TOKENS` as JSON: {"<agentId>":"<secret>", ...}.
 * Tokens are never logged and are compared in constant time over digests.
 * This is an application authentication adapter; it does not use x-agent-id.
 */
export function loadAgentTokens(raw = process.env.A423_AGENT_TOKENS): Map<string, string> {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('A423_AGENT_TOKENS must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A423_AGENT_TOKENS must be a JSON object of agentId -> token');
  }
  const map = new Map<string, string>();
  for (const [agentId, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) throw new Error('invalid agent id in A423_AGENT_TOKENS');
    if (typeof token !== 'string' || token.length < 16) throw new Error('agent tokens must be at least 16 characters');
    map.set(agentId, token);
  }
  return map;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export function authenticateBearer(
  request: Request,
  tokens: Map<string, string> = loadAgentTokens(),
): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const presented = digest(match[1]);
  for (const [agentId, expected] of tokens) {
    if (timingSafeEqual(presented, digest(expected))) return agentId;
  }
  return null;
}
