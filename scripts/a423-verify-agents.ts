/**
 * Development-only agent verification: requests a challenge from the local
 * governor, signs it with the agent's private ed25519 key, and stores the signed
 * credential. Run after scripts/a423-identity-setup.ts.
 */
import 'dotenv/config';
import { createPrivateKey, sign } from 'crypto';
import { listRegistry, createChallenge, verifyChallenge, governorStatus, loadPrivateKeyFile } from '../lib/a423/governor';

const b64url = (b: Buffer) => b.toString('base64url');

async function main() {
  const keys = loadPrivateKeyFile();
  const agents = await listRegistry();
  if (agents.length === 0) throw new Error('no registered agents; run scripts/a423-identity-setup.ts');
  for (const agent of agents) {
    const current = await governorStatus(agent.app_agent_id);
    if (current.verified) {
      console.log(`${agent.agent_name}: already verified until ${current.expires_at}`);
      continue;
    }
    const agentKey = keys.agents[agent.app_agent_id]?.private_key;
    if (!agentKey) throw new Error(`missing private key for ${agent.app_agent_id}`);
    const challenge = await createChallenge(agent.app_agent_id);
    const signature = b64url(sign(null, Buffer.from(challenge.message, 'utf8'), createPrivateKey(agentKey)));
    const verified = await verifyChallenge({
      appAgentId: agent.app_agent_id,
      challengeId: challenge.challenge_id,
      code: challenge.code,
      signature,
    });
    console.log(`${agent.agent_name}: verified as ${verified.agent.agent_id}`);
    console.log(`  org: ${verified.agent.org_id}`);
    console.log(`  credential expires: ${new Date(verified.credential_payload.exp).toISOString()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
