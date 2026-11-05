import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { VERSION, createIdentity, type Identity } from '@allorc/identity';
import { getDb } from '@/lib/db/client';
import { arbiterId } from './ethers';
import { agents } from '@/lib/db/schema';
import {
  createChallenge,
  ensureGovernorSchema,
  getRegistryByAppId,
  governorConfigPath,
  governorPrivatePath,
  governorStatus,
  listRegistry,
  registerAgentRecord,
  verifyChallenge,
  type AgentPublicRecord,
  type GovernorConfig,
  type PrivateKeyFile,
} from './governor';

const b64url = (b: Buffer) => b.toString('base64url');

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export type BootstrapAgent = {
  app_agent_id: string;
  agent_id: string;
  agent_name: string;
  org_id: string;
  org_public_key: string;
  agent_public_key: string;
  status: 'pending' | 'verified';
  verified: boolean;
  expires_at: string | null;
};

export type BootstrapResult = {
  governor: { key_id: string; algorithm: 'ed25519'; public_key: string };
  organizations: GovernorConfig['organizations'];
  agents: BootstrapAgent[];
};

/**
 * Local development bootstrap used by the dashboard mount modal.
 * Generates missing org/agent keys, writes the public registry + gitignored
 * private keys, then completes challenge → signature → credential for each
 * registered agent. Idempotent; never returns private material.
 */
export async function bootstrapDevIdentities(): Promise<BootstrapResult> {
  ensureGovernorSchema();
  const db = getDb();
  const rows = await db.select().from(agents).orderBy(agents.createdAt);
  const targets = rows.filter((a) => a.name === 'Agent A' || a.name === 'Agent B');
  if (targets.length < 2) throw new Error('seed Agent A and Agent B first');

  const publicPath = governorConfigPath();
  const privatePath = governorPrivatePath();
  mkdirSync(dirname(publicPath), { recursive: true });
  mkdirSync(dirname(privatePath), { recursive: true });

  const existingPrivate = readJson<PrivateKeyFile>(privatePath);
  const privateFile: PrivateKeyFile = existingPrivate ?? {
    version: 'a423.private.v1',
    governor: { key_id: `gov-${randomUUID()}`, ...keypair() },
    organizations: {},
    agents: {},
  };

  for (const agent of targets) {
    if (getRegistryByAppId(agent.id)) continue;
    const orgId = `a423:org:v1:${b64url(randomBytes(16))}`;
    const orgKeys = keypair();
    const agentKeys = keypair();
    const identity: Identity = createIdentity({
      version: VERSION,
      organization_public_key: orgKeys.public_key,
      agent_reference: agent.id,
      agent_name: agent.name,
      agent_email: `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@agents.a423.local`,
    });
    privateFile.organizations[orgId] = orgKeys;
    privateFile.agents[agent.id] = agentKeys;
    registerAgentRecord({
      agent_id: identity.agent_id,
      app_agent_id: agent.id,
      org_id: orgId,
      agent_reference: identity.agent_reference,
      agent_name: identity.agent_name,
      agent_email: identity.agent_email,
      agent_public_key: agentKeys.public_key,
      org_public_key: orgKeys.public_key,
      identity,
      identity_version: identity.version,
    });
  }

  const arbiter = arbiterId();
  if (!getRegistryByAppId(arbiter)) {
    const primary = getRegistryByAppId(targets[0].id);
    if (!primary) throw new Error('primary agent registry missing');
    const arbiterKeys = keypair();
    const identity: Identity = createIdentity({
      version: VERSION,
      organization_public_key: primary.org_public_key,
      agent_reference: arbiter,
      agent_name: 'A423 Arbiter',
      agent_email: 'arbiter@agents.a423.local',
    });
    privateFile.agents[arbiter] = arbiterKeys;
    registerAgentRecord({
      agent_id: identity.agent_id,
      app_agent_id: arbiter,
      org_id: primary.org_id,
      agent_reference: identity.agent_reference,
      agent_name: identity.agent_name,
      agent_email: identity.agent_email,
      agent_public_key: arbiterKeys.public_key,
      org_public_key: primary.org_public_key,
      identity,
      identity_version: identity.version,
    });
  }

  const records = listRegistry();
  const config: GovernorConfig = {
    version: 'a423.orgs.v1',
    generated_at: new Date().toISOString(),
    governor: {
      key_id: privateFile.governor.key_id,
      algorithm: 'ed25519',
      public_key: privateFile.governor.public_key,
    },
    organizations: records.map((record) => ({
      org_id: record.org_id,
      name: `${record.agent_name} Organization`,
      public_key: record.org_public_key,
      agent: {
        agent_id: record.agent_id,
        app_agent_id: record.app_agent_id,
        org_id: record.org_id,
        agent_reference: record.agent_reference,
        agent_name: record.agent_name,
        agent_email: record.agent_email,
        agent_public_key: record.agent_public_key,
        org_public_key: record.org_public_key,
        identity: record.identity,
        identity_version: record.identity_version,
      },
    })),
  };
  writeFileSync(publicPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(privatePath, `${JSON.stringify(privateFile, null, 2)}\n`);
  chmodSync(privatePath, 0o600);

  for (const record of records) {
    const current = governorStatus(record.app_agent_id);
    if (current.verified) continue;
    const agentKey = privateFile.agents[record.app_agent_id]?.private_key;
    if (!agentKey) throw new Error(`missing local private key for ${record.app_agent_id}`);
    const challenge = createChallenge(record.app_agent_id);
    const signature = b64url(sign(null, Buffer.from(challenge.message, 'utf8'), createPrivateKey(agentKey)));
    verifyChallenge({
      appAgentId: record.app_agent_id,
      challengeId: challenge.challenge_id,
      code: challenge.code,
      signature,
    });
  }

  const targetIds = new Set(targets.map((a) => a.id));
  const agentsOut: BootstrapAgent[] = listRegistry()
    .filter((record) => targetIds.has(record.app_agent_id))
    .map((record: AgentPublicRecord) => {
    const status = governorStatus(record.app_agent_id);
    return {
      app_agent_id: record.app_agent_id,
      agent_id: record.agent_id,
      agent_name: record.agent_name,
      org_id: record.org_id,
      org_public_key: record.org_public_key,
      agent_public_key: record.agent_public_key,
      status: status.verified ? 'verified' : 'pending',
      verified: status.verified,
      expires_at: status.expires_at,
    };
  });

  return { governor: config.governor, organizations: config.organizations, agents: agentsOut };
}
