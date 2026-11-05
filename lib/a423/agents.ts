import { getDb } from '@/lib/db/client';
import { agents, agentWallets } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSigner } from '@/lib/chain/config';
import type { Address } from 'viem';

export type ResolvedAgent = {
  id: string;
  name: string;
  wallet: Address;
  signerIndex: number;
};

/**
 * A423 identity -> wallet/signer binding. This resolver:
 *   - never falls back to index 0,
 *   - never derives the signer index from row order,
 *   - requires an explicit `keyReference` (signer:N / demo-signer:N),
 *   - verifies the derived signer address equals the registered wallet,
 *   - rejects paused or unknown agents.
 */
export async function resolveAgent(agentId: string): Promise<ResolvedAgent> {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) {
    throw new Error('unknown agent identity');
  }
  const db = getDb();
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.status !== 'active') throw new Error('unknown or inactive agent');
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  if (!wallet) throw new Error('agent has no registered wallet');
  if (wallet.paused) throw new Error('agent wallet is paused');

  const match = /^(?:demo-)?signer:(\d{1,3})$/.exec(wallet.keyReference ?? '');
  if (!match) throw new Error('agent wallet has no explicit signer binding');
  const signerIndex = Number(match[1]);
  let signerAddress: string;
  try {
    signerAddress = getSigner(signerIndex).address;
  } catch {
    throw new Error('configured signer is unavailable');
  }
  if (signerAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('registered wallet does not match the configured signer');
  }
  return { id: agent.id, name: agent.name, wallet: wallet.address as Address, signerIndex };
}

export async function resolveParticipants(
  participants: { requester: string; worker: string; verifier: string },
): Promise<{ requester: ResolvedAgent; worker: ResolvedAgent; verifier: ResolvedAgent }> {
  const [requester, worker, verifier] = await Promise.all([
    resolveAgent(participants.requester),
    resolveAgent(participants.worker),
    resolveAgent(participants.verifier),
  ]);
  if (requester.id === worker.id) throw new Error('requester and worker must differ');
  for (const r of [requester, worker, verifier]) {
    if (!r.wallet) throw new Error('participant wallet missing');
  }
  return { requester, worker, verifier };
}
