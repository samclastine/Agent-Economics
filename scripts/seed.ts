/**
 * Seed the A423 demo agents and their signer-bound wallets.
 * Run after setting CHAIN_ID/RPC_URL and the DEMO_SIGNER_KEYS.
 *
 *   npx tsx scripts/seed.ts
 */
import 'dotenv/config';
import { getDb } from '../lib/db/client';
import { users, agents, agentWallets } from '../lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSigner } from '../lib/chain/config';
import type { Address } from 'viem';

async function main() {
  const db = getDb();
  const chainIdNum = Number(process.env.CHAIN_ID ?? 46630);

  let owner = await db.query.users.findFirst({ where: eq(users.name, 'demo-owner') });
  if (!owner) {
    [owner] = await db.insert(users).values({ name: 'demo-owner', role: 'owner' }).returning();
  }

  async function ensureAgent(name: string, role: string, signerIdx: number) {
    let agent = await db.query.agents.findFirst({ where: eq(agents.name, name) });
    if (!agent) {
      [agent] = await db.insert(agents).values({
        ownerUserId: owner!.id, name, role,
      }).returning();
    }
    const account = getSigner(signerIdx);
    const address = account.address as Address;
    let wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agent.id) });
    if (!wallet) {
      [wallet] = await db.insert(agentWallets).values({
        agentId: agent.id,
        chainId: chainIdNum,
        address,
        walletType: 'evm_eoa',
        keyReference: `demo-signer:${signerIdx}`,
      }).returning();
    }
    return { agent, wallet: wallet!, address };
  }

  const A = await ensureAgent('Agent A', 'dispatcher', 0);
  const B = await ensureAgent('Agent B', 'worker', 1);
  console.log('Agent A', A.agent.id, A.address);
  console.log('Agent B', B.agent.id, B.address);
  console.log('seed complete');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
