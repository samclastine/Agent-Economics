import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, timingSafeEqual, verify } from 'crypto';
import { readFileSync } from 'fs';
import type { Identity } from '@allorc/identity';
import { sqlAll, sqlExec, sqlGet, sqlRun, sqlTransaction } from '@/lib/db/sql';
import { canonicalJson } from './ids';

/**
 * Fake-but-real-crypto governor for local development.
 *
 * Flow:
 *   1. An organisation registers a public ed25519 key and an agent identity
 *      derived by @allorc/identity (public ingredients only).
 *   2. The agent requests a one-time challenge code.
 *   3. The agent signs `challengeMessage(...)` with its private ed25519 key.
 *   4. The governor verifies the signature against the registered public key and
 *      issues a short-lived signed credential.
 *   5. The A423 workflow authorize hook checks that credential before allowing
 *      agents to create/quote/fund/start.
 *
 * This is an internal development governor. It is not a public authority and
 * must not be presented as one.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS a423_organizations (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS a423_agent_registry (
  agent_id TEXT PRIMARY KEY,
  app_agent_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES a423_organizations(org_id),
  agent_reference TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_public_key TEXT NOT NULL,
  org_public_key TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  identity_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE TABLE IF NOT EXISTS a423_verification_challenges (
  challenge_id TEXT PRIMARY KEY,
  app_agent_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS a423_verifications (
  app_agent_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  credential TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  governor_key_id TEXT NOT NULL
);
`;

export class GovernorError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type OrganizationPublicRecord = {
  org_id: string;
  name: string;
  public_key: string;
};

export type AgentPublicRecord = {
  agent_id: string;
  app_agent_id: string;
  org_id: string;
  agent_reference: string;
  agent_name: string;
  agent_email: string;
  agent_public_key: string;
  org_public_key: string;
  identity: Identity;
  identity_version: string;
  status: 'pending' | 'verified';
  created_at: string;
  verified_at: string | null;
};

export type GovernorConfig = {
  version: 'a423.orgs.v1';
  generated_at: string;
  governor: { key_id: string; algorithm: 'ed25519'; public_key: string };
  organizations: Array<OrganizationPublicRecord & { agent: Omit<AgentPublicRecord, 'status' | 'created_at' | 'verified_at'> }>;
};

type RegistryRow = {
  agent_id: string;
  app_agent_id: string;
  org_id: string;
  agent_reference: string;
  agent_name: string;
  agent_email: string;
  agent_public_key: string;
  org_public_key: string;
  identity_json: string;
  identity_version: string;
  status: 'pending' | 'verified';
  created_at: number;
  verified_at: number | null;
};

export type CredentialPayload = {
  v: 1;
  sub: string;
  app_agent_id: string;
  org_id: string;
  key_sha256: string;
  scope: 'a423.workflow';
  iat: number;
  exp: number;
  jti: string;
};

let schemaReady: Promise<void> | null = null;

export function ensureGovernorSchema(): Promise<void> {
  return (schemaReady ??= sqlExec(SCHEMA));
}

export function governorConfigPath(): string {
  return process.env.A423_ORGS_CONFIG ?? 'config/a423-organizations.json';
}

export function governorPrivatePath(): string {
  return process.env.A423_PRIVATE_KEYS ?? '.a423/a423-private-keys.json';
}

export function loadGovernorConfig(): GovernorConfig {
  let parsed: GovernorConfig;
  try {
    parsed = JSON.parse(readFileSync(/*turbopackIgnore: true*/ governorConfigPath(), 'utf8')) as GovernorConfig;
  } catch {
    throw new GovernorError('GOVERNOR_NOT_CONFIGURED', 'Governor organization config is missing', 503);
  }
  if (parsed.version !== 'a423.orgs.v1' || !parsed.governor?.public_key || !Array.isArray(parsed.organizations)) {
    throw new GovernorError('GOVERNOR_NOT_CONFIGURED', 'Governor organization config is invalid', 503);
  }
  return parsed;
}

export type PrivateKeyFile = {
  version: 'a423.private.v1';
  governor: { key_id: string; private_key: string; public_key: string };
  organizations: Record<string, { private_key: string; public_key: string }>;
  agents: Record<string, { private_key: string; public_key: string }>;
};

export function loadPrivateKeyFile(): PrivateKeyFile {
  try {
    if (process.env.A423_PRIVATE_KEYS_JSON) return JSON.parse(process.env.A423_PRIVATE_KEYS_JSON) as PrivateKeyFile;
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ governorPrivatePath(), 'utf8')) as PrivateKeyFile;
  } catch {
    throw new GovernorError('GOVERNOR_KEYS_MISSING', 'Governor private keys are not configured', 503);
  }
}

function rowToRecord(row: RegistryRow): AgentPublicRecord {
  return {
    agent_id: row.agent_id,
    app_agent_id: row.app_agent_id,
    org_id: row.org_id,
    agent_reference: row.agent_reference,
    agent_name: row.agent_name,
    agent_email: row.agent_email,
    agent_public_key: row.agent_public_key,
    org_public_key: row.org_public_key,
    identity: JSON.parse(row.identity_json) as Identity,
    identity_version: row.identity_version,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
  };
}

export async function registerAgentRecord(record: Omit<AgentPublicRecord, 'created_at' | 'verified_at' | 'status'> & { status?: 'pending' | 'verified' }): Promise<void> {
  await ensureGovernorSchema();
  const now = Date.now();
  await sqlTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO a423_organizations (org_id, name, public_key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key`,
      [record.org_id, record.identity.agent_name + ' org', record.org_public_key, now],
    );
    await tx.run(
      `INSERT INTO a423_agent_registry
         (agent_id, app_agent_id, org_id, agent_reference, agent_name, agent_email, agent_public_key, org_public_key, identity_json, identity_version, status, created_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_agent_id) DO UPDATE SET
         agent_id = excluded.agent_id, org_id = excluded.org_id,
         agent_reference = excluded.agent_reference, agent_name = excluded.agent_name,
         agent_email = excluded.agent_email, agent_public_key = excluded.agent_public_key,
         org_public_key = excluded.org_public_key, identity_json = excluded.identity_json,
         identity_version = excluded.identity_version`,
      [
        record.agent_id, record.app_agent_id, record.org_id, record.agent_reference,
        record.agent_name, record.agent_email, record.agent_public_key, record.org_public_key,
        JSON.stringify(record.identity), record.identity_version, record.status ?? 'pending', now,
        record.status === 'verified' ? now : null,
      ],
    );
  });
}

export async function getRegistryByAppId(appAgentId: string): Promise<AgentPublicRecord | null> {
  await ensureGovernorSchema();
  const row = await sqlGet<RegistryRow>('SELECT * FROM a423_agent_registry WHERE app_agent_id = ?', [appAgentId]);
  return row ? rowToRecord(row) : null;
}

export async function getRegistryByIdentityId(agentId: string): Promise<AgentPublicRecord | null> {
  await ensureGovernorSchema();
  const row = await sqlGet<RegistryRow>('SELECT * FROM a423_agent_registry WHERE agent_id = ?', [agentId]);
  return row ? rowToRecord(row) : null;
}

export async function listRegistry(): Promise<AgentPublicRecord[]> {
  await ensureGovernorSchema();
  const rows = await sqlAll<RegistryRow>('SELECT * FROM a423_agent_registry ORDER BY created_at ASC');
  return rows.map(rowToRecord);
}

const hashCode = (code: string) => createHash('sha256').update(code).digest();
const b64url = (b: Buffer) => b.toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url');

export function challengeMessage(identityAgentId: string, challengeId: string, code: string): string {
  return `a423.verify.v1\n${identityAgentId}\n${challengeId}\n${code}`;
}

export async function createChallenge(appAgentId: string): Promise<{
  challenge_id: string;
  agent_id: string;
  app_agent_id: string;
  code: string;
  message: string;
  expires_at: string;
}> {
  const record = await getRegistryByAppId(appAgentId);
  if (!record) throw new GovernorError('AGENT_NOT_REGISTERED', 'Agent is not registered with the governor', 404);
  const challengeId = `chl-${randomUUID()}`;
  const code = b64url(randomBytes(32));
  const ttl = Number(process.env.A423_CHALLENGE_TTL_MS ?? 5 * 60 * 1000);
  const expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 300_000);
  await sqlRun(
    'INSERT INTO a423_verification_challenges (challenge_id, app_agent_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [challengeId, appAgentId, hashCode(code).toString('hex'), expiresAt, Date.now()],
  );
  return {
    challenge_id: challengeId,
    agent_id: record.agent_id,
    app_agent_id: record.app_agent_id,
    code,
    message: challengeMessage(record.agent_id, challengeId, code),
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export function signCredential(payload: CredentialPayload): string {
  const keys = loadPrivateKeyFile();
  const body = canonicalJson(payload);
  const signature = sign(null, Buffer.from(body, 'utf8'), createPrivateKey(keys.governor.private_key));
  return `${b64url(Buffer.from(body, 'utf8'))}.${b64url(signature)}`;
}

export function verifyCredential(token: string, publicKeyPem?: string): CredentialPayload | null {
  try {
    const [bodyPart, sigPart] = token.split('.');
    if (!bodyPart || !sigPart) return null;
    const payload = JSON.parse(unb64url(bodyPart).toString('utf8')) as CredentialPayload;
    if (payload.v !== 1 || payload.scope !== 'a423.workflow') return null;
    const publicKey = createPublicKey(publicKeyPem ?? loadGovernorConfig().governor.public_key);
    const ok = verify(null, Buffer.from(canonicalJson(payload), 'utf8'), publicKey, unb64url(sigPart));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

export async function verifyChallenge(args: {
  appAgentId: string;
  challengeId: string;
  code: string;
  signature: string;
}): Promise<{ status: 'verified'; agent: AgentPublicRecord; credential: string; credential_payload: CredentialPayload }> {
  const record = await getRegistryByAppId(args.appAgentId);
  if (!record) throw new GovernorError('AGENT_NOT_REGISTERED', 'Agent is not registered with the governor', 404);
  const row = await sqlGet<{ challenge_id: string; code_hash: string; expires_at: number; used_at: number | null }>(
    'SELECT * FROM a423_verification_challenges WHERE challenge_id = ? AND app_agent_id = ?',
    [args.challengeId, args.appAgentId],
  );
  if (!row) throw new GovernorError('CHALLENGE_NOT_FOUND', 'Challenge not found', 404);
  if (row.used_at) throw new GovernorError('CHALLENGE_USED', 'Challenge already used', 409);
  if (Date.now() > row.expires_at) throw new GovernorError('CHALLENGE_EXPIRED', 'Challenge expired', 410);
  const presented = hashCode(args.code);
  const expected = Buffer.from(row.code_hash, 'hex');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new GovernorError('CHALLENGE_CODE_MISMATCH', 'Challenge code does not match', 403);
  }
  const message = challengeMessage(record.agent_id, args.challengeId, args.code);
  let ok = false;
  try {
    ok = verify(null, Buffer.from(message, 'utf8'), createPublicKey(record.agent_public_key), unb64url(args.signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new GovernorError('SIGNATURE_INVALID', 'Agent signature is invalid', 403);

  const now = Date.now();
  const ttl = Number(process.env.A423_CREDENTIAL_TTL_MS ?? 24 * 60 * 60 * 1000);
  const expiresAt = now + (Number.isFinite(ttl) && ttl > 0 ? ttl : 86_400_000);
  const config = loadGovernorConfig();
  const payload: CredentialPayload = {
    v: 1,
    sub: record.agent_id,
    app_agent_id: record.app_agent_id,
    org_id: record.org_id,
    key_sha256: createHash('sha256').update(record.agent_public_key).digest('hex'),
    scope: 'a423.workflow',
    iat: now,
    exp: expiresAt,
    jti: `cred-${randomUUID()}`,
  };
  const credential = signCredential(payload);
  await sqlTransaction(async (tx) => {
    await tx.run('UPDATE a423_verification_challenges SET used_at = ? WHERE challenge_id = ?', [now, args.challengeId]);
    await tx.run(
      `INSERT INTO a423_verifications (app_agent_id, agent_id, org_id, credential, issued_at, expires_at, governor_key_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_agent_id) DO UPDATE SET
         agent_id = excluded.agent_id, org_id = excluded.org_id, credential = excluded.credential,
         issued_at = excluded.issued_at, expires_at = excluded.expires_at, governor_key_id = excluded.governor_key_id`,
      [record.app_agent_id, record.agent_id, record.org_id, credential, now, expiresAt, config.governor.key_id],
    );
    await tx.run('UPDATE a423_agent_registry SET status = \'verified\', verified_at = ? WHERE app_agent_id = ?', [now, record.app_agent_id]);
  });
  const verified = await getRegistryByAppId(record.app_agent_id);
  if (!verified) throw new GovernorError('AGENT_NOT_REGISTERED', 'Agent disappeared during verification', 404);
  return { status: 'verified', agent: verified, credential, credential_payload: payload };
}

export async function getVerification(appAgentId: string): Promise<{ credential: string; expires_at: number } | null> {
  await ensureGovernorSchema();
  const row = await sqlGet<{ credential: string; expires_at: number }>(
    'SELECT credential, expires_at FROM a423_verifications WHERE app_agent_id = ?',
    [appAgentId],
  );
  return row ?? null;
}

export async function governorStatus(appAgentId: string): Promise<{
  verified: boolean;
  agent: AgentPublicRecord | null;
  expires_at: string | null;
  governor_key_id: string | null;
  reason?: string;
}> {
  const agent = await getRegistryByAppId(appAgentId);
  if (!agent) return { verified: false, agent: null, expires_at: null, governor_key_id: null, reason: 'not_registered' };
  const verification = await getVerification(appAgentId);
  if (!verification) return { verified: false, agent, expires_at: null, governor_key_id: null, reason: 'not_verified' };
  const config = loadGovernorConfig();
  const payload = verifyCredential(verification.credential, config.governor.public_key);
  if (!payload) return { verified: false, agent, expires_at: null, governor_key_id: null, reason: 'credential_invalid' };
  if (payload.sub !== agent.agent_id || payload.app_agent_id !== agent.app_agent_id || payload.org_id !== agent.org_id) {
    return { verified: false, agent, expires_at: null, governor_key_id: null, reason: 'credential_binding_mismatch' };
  }
  if (payload.exp <= Date.now()) return { verified: false, agent, expires_at: new Date(payload.exp).toISOString(), governor_key_id: config.governor.key_id, reason: 'credential_expired' };
  if (agent.status !== 'verified') return { verified: false, agent, expires_at: new Date(payload.exp).toISOString(), governor_key_id: config.governor.key_id, reason: 'registry_not_verified' };
  return { verified: true, agent, expires_at: new Date(payload.exp).toISOString(), governor_key_id: config.governor.key_id };
}

export async function isAgentVerified(appAgentId: string): Promise<boolean> {
  try {
    return (await governorStatus(appAgentId)).verified;
  } catch {
    return false;
  }
}
