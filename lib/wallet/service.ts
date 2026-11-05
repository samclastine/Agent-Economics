import { getDb } from '@/lib/db/client';
import { agentWallets, agents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publicClient, getTokenMeta } from '@/lib/chain/config';
import { ERC20_ABI } from '@/lib/chain/abis';
import type { Address } from 'viem';

type A423WalletPosition = {
  id: string;
  jobId: string;
  amountRaw: string;
  state: string;
  role: 'requester' | 'worker';
};

/**
 * A423 workflows live in the SDK operations database. Project their escrow
 * ledger into the wallet so locked funds and worker receivables are visible.
 */
async function a423EscrowPositions(agentId: string): Promise<{
  locked: bigint;
  positions: A423WalletPosition[];
}> {
  if (process.env.A423_CHAT_MODE !== 'sdk') return { locked: 0n, positions: [] };
  try {
    const { getA423Bridge } = await import('@/lib/a423/bridge04');
    const bridge = await getA423Bridge();
    const jobs = await bridge.storage.jobs.list({ actor: agentId, limit: 1000 });
    let locked = 0n;
    const positions: A423WalletPosition[] = [];
    for (const job of jobs) {
      const ledger = job.escrow_ledger;
      const raw = ledger && typeof ledger.locked_amount === 'string' && /^\d+$/.test(ledger.locked_amount)
        ? BigInt(ledger.locked_amount)
        : 0n;
      if (raw <= 0n) continue;
      const roles = (['requester', 'worker'] as const)
        .filter((role) => job.participants[role] === agentId);
      for (const role of roles) {
        if (role === 'requester') locked += raw;
        positions.push({ id: `${job.id}:${role}`, jobId: job.id, amountRaw: raw.toString(), state: job.state, role });
      }
    }
    return { locked, positions };
  } catch {
    return { locked: 0n, positions: [] };
  }
}

export async function getWalletView(agentId: string) {
  const db = getDb();
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  const meta = await getTokenMeta();

  let tokenBalance = '0';
  let ethBalance = '0';
  if (wallet && meta.address !== '0x0000000000000000000000000000000000000000') {
    try {
      const pc = publicClient();
      const [bal, eth] = await Promise.all([
        pc.readContract({
          address: meta.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address as Address],
        }).catch(() => 0n),
        pc.getBalance({ address: wallet.address as Address }),
      ]);
      tokenBalance = bal.toString();
      ethBalance = eth.toString();
    } catch { /* chain unavailable */ }
  }

  const a423 = await a423EscrowPositions(agentId);

  return {
    agent: { id: agent?.id, name: agent?.name, role: agent?.role },
    wallet: wallet && {
      address: wallet.address,
      chainId: wallet.chainId,
      paused: wallet.paused,
    },
    token: {
      address: meta.address,
      decimals: meta.decimals,
      spendableRaw: tokenBalance,
      lockedInEscrowRaw: a423.locked.toString(),
      symbol: meta.symbol,
      isMock: meta.symbol === 'tWIF',
    },
    gas: { ethBalanceWei: ethBalance },
    escrows: a423.positions,
  };
}
