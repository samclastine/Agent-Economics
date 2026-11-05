/**
 * Generates two organizations (one per seeded agent), ed25519 org keys, agent
 * keypairs, and deterministic @allorc/identity identities.
 *
 * Public records: config/a423-organizations.json (safe to commit)
 * Private keys:   .a423/a423-private-keys.json  (gitignored, mode 0600)
 *
 * Idempotent: existing registry identities/keys are reused. Run after seed.
 */
import 'dotenv/config';
import { generateKeyPairSync, randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { VERSION, createIdentity, type Identity } from '@allorc/identity';
import { getDb } from '../lib/db/client';
import { agents } from '../lib/db/schema';
import {
  ensureGovernorSchema,
  getRegistryByAppId,
  governorConfigPath,
  governorPrivatePath,
  registerAgentRecord,
  type GovernorConfig,
  type PrivateKeyFile,
} from '../lib/a423/governor';

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

async function main() {
  ensureGovernorSchema();
  const db = getDb();
  const agentRows = await db.select().from(agents).orderBy(agents.createdAt);
  const targets = agentRows.filter((a) => a.name === 'Agent A' || a.name === 'Agent B');
  if (targets.length < 2) throw new Error('seed the two agents first (scripts/seed.ts)');

  const privPath = governorPrivatePath();
  const publicPath = governorConfigPath();
  mkdirSync(dirname(privPath), { recursive: true });
  mkdirSync(dirname(publicPath), { recursive: true });

  const existingPrivate = readJson<PrivateKeyFile>(privPath);
  const governorKeys = existingPrivate?.governor ?? { key_id: `gov-${randomUUID()}`, ...keypair() };
  const privateFile: PrivateKeyFile = existingPrivate ?? {
    version: 'a423.private.v1',
    governor: governorKeys,
    organizations: {},
    agents: {},
  };
  privateFile.governor = governorKeys;

  const config: GovernorConfig = {
    version: 'a423.orgs.v1',
    generated_at: new Date().toISOString(),
    governor: { key_id: governorKeys.key_id, algorithm: 'ed25519', public_key: governorKeys.public_key },
    organizations: [],
  };

  for (const agent of targets) {
    const existing = getRegistryByAppId(agent.id);
    if (existing) {
      config.organizations.push({
        org_id: existing.org_id,
        name: `${existing.agent_name} Organization`,
        public_key: existing.org_public_key,
        agent: {
          agent_id: existing.agent_id,
          app_agent_id: existing.app_agent_id,
          org_id: existing.org_id,
          agent_reference: existing.agent_reference,
          agent_name: existing.agent_name,
          agent_email: existing.agent_email,
          agent_public_key: existing.agent_public_key,
          org_public_key: existing.org_public_key,
          identity: existing.identity,
          identity_version: existing.identity_version,
        },
      });
      console.log(`${agent.name}: existing identity ${existing.agent_id}`);
      continue;
    }

    const orgId = `a423:org:v1:${b64url(randomBytes(16))}`;
    const orgKeys = keypair();
    const agentKeys = keypair();
    const ingredients = {
      version: VERSION,
      organization_public_key: orgKeys.public_key,
      agent_reference: agent.id,
      agent_name: agent.name,
      agent_email: `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@agents.a423.local`,
    };
    const identity: Identity = createIdentity(ingredients);
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
    config.organizations.push({
      org_id: orgId,
      name: `${agent.name} Organization`,
      public_key: orgKeys.public_key,
      agent: {
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
      },
    });
    console.log(`${agent.name}: org ${orgId}`);
    console.log(`${agent.name}: identity ${identity.agent_id}`);
  }

  writeFileSync(publicPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(privPath, JSON.stringify(privateFile, null, 2) + '\n');
  chmodSync(privPath, 0o600);
  console.log(`public config: ${publicPath}`);
  console.log(`private keys:  ${privPath} (gitignored)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
