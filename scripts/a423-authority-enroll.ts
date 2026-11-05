/**
 * One-time operator enrollment into the SDK authority. No HTTP endpoint.
 * Org keys from the existing @allorc/identity setup sign each agent enrollment.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createPrivateKey, sign } from 'crypto';
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
import { createAuthority } from '@allorc/a423-sdk/authority';
import { getDb, getSqlite } from '../lib/db/client';
import { agents } from '../lib/db/schema';

const storage = createSqliteStorage({ filename: process.env.A423_STORAGE_FILE ?? 'data/a423-operations.sqlite' });
const authority = createAuthority({
  issuer: process.env.A423_AUTHORITY_ISSUER ?? 'a423-local-authority',
  audience: process.env.A423_AUTHORITY_AUDIENCE ?? 'a423-local-app',
  privateKey: readFileSync(process.env.A423_AUTHORITY_KEY_PATH ?? '.a423/authority-04.pem', 'utf8'),
  kv: storage.kv,
  credentialTtlSeconds: 3600,
});

type PrivateKeys = {
  organizations: Record<string, { private_key: string; public_key: string }>;
  agents: Record<string, { private_key: string; public_key: string }>;
};

async function main() {
  const keys = JSON.parse(readFileSync('.a423/a423-private-keys.json', 'utf8')) as PrivateKeys;
  const db = getDb();
  const rows = await db.select().from(agents);
  const agentA = rows.find((a) => a.name === 'Agent A');
  const agentB = rows.find((a) => a.name === 'Agent B');
  if (!agentA || !agentB) throw new Error('seed agents first');
  const arbiterId = process.env.A423_ARBITER_ID ?? 'a423-arbiter';
  const aOrg = storageOrgFor(agentA.id);
  const bOrg = storageOrgFor(agentB.id);

  for (const orgId of new Set([aOrg.org_id, bOrg.org_id])) {
    const org = keys.organizations[orgId];
    if (!org) throw new Error(`missing org private key ${orgId}`);
    try {
      await authority.registerOrganization({ id: orgId, name: orgId, publicKey: org.public_key });
      console.log('registered organization', orgId);
    } catch (error) {
      if (!/already registered/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  await enroll(agentA.id, aOrg.org_id, keys);
  await enroll(agentB.id, bOrg.org_id, keys);
  await enroll(arbiterId, aOrg.org_id, keys);
  console.log('authority enrollment complete');
}

function storageOrgFor(appAgentId: string): { org_id: string } {
  const raw = getSqlite().prepare('SELECT org_id FROM a423_agent_registry WHERE app_agent_id = ?').get(appAgentId) as { org_id: string } | undefined;
  if (!raw) throw new Error(`no registry org for ${appAgentId}`);
  return { org_id: raw.org_id };
}

async function enroll(appAgentId: string, orgId: string, keys: PrivateKeys) {
  const key = keys.agents[appAgentId];
  if (!key) throw new Error(`missing agent identity key for ${appAgentId}`);
  const scopes = ['workflow', 'spend'];
  const statement = authority.registration({ organization: orgId, agentId: appAgentId, publicKey: key.public_key, scopes });
  const orgKey = keys.organizations[orgId];
  if (!orgKey) throw new Error(`missing org key ${orgId}`);
  const signature = sign(null, Buffer.from(JSON.stringify(statement)), createPrivateKey(orgKey.private_key)).toString('base64url');
  try {
    await authority.registerAgent({ organization: orgId, agentId: appAgentId, publicKey: key.public_key, scopes, organizationSignature: signature });
    console.log('enrolled agent', appAgentId, 'in', orgId);
  } catch (error) {
    if (!/already registered/i.test(error instanceof Error ? error.message : String(error))) throw error;
    console.log('already enrolled', appAgentId);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
