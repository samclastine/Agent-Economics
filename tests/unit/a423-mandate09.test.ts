import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
import { createMandateRegistry } from '@allorc/a423-sdk/mandate';

const TOKEN = '0x663F3ad617193148711d28f5334eE4Ed07016602';

describe('A423 0.9 mandates', () => {
  it('enforces actions, budget and expiry', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    let now = 1_700_000_000_000;
    const mandates = createMandateRegistry({
      mandates: [{
        agentId: 'buyer',
        id: 'buyer-1',
        actions: ['create', 'fund'],
        budget: { chainId: 1, tokenAddress: TOKEN, total: '10', perTransaction: '10', daily: '10' },
        duration: { seconds: 60 },
      }],
      kv: storage.kv,
      spending: storage.spending,
      now: () => now,
    });
    await mandates.ready();
    expect((await mandates.get('buyer')).actions).toEqual(['create', 'fund']);
    expect(await mandates.authorize({ actor: 'buyer', action: 'create' })).toBe(true);
    expect(await mandates.authorize({ actor: 'buyer', action: 'fund' })).toBe(true);
    expect(await mandates.authorize({ actor: 'buyer', action: 'accept' })).toBe(false);

    expect(await mandates.reserveBudget({ actor: 'buyer', action: 'fund', requestId: 'r1', amount: '6', chainId: 1, tokenAddress: TOKEN })).toBe(true);
    expect(await mandates.reserveBudget({ actor: 'buyer', action: 'fund', requestId: 'r2', amount: '5', chainId: 1, tokenAddress: TOKEN })).toBe(false);

    now += 61_000;
    expect(await mandates.authorize({ actor: 'buyer', action: 'create' })).toBe(false);
    storage.close();
  });

  it('defaults to all actions, unlimited budget and lifetime', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    const mandates = createMandateRegistry({
      mandates: [{ agentId: 'worker' }],
      kv: storage.kv,
      spending: storage.spending,
    });
    await mandates.ready();
    const effective = await mandates.get('worker');
    expect(effective.actions).toBe('all');
    expect(effective.budget).toBeNull();
    expect(effective.expiresAt).toBeNull();
    expect(await mandates.authorize({ actor: 'worker', action: 'fund' })).toBe(true);
    storage.close();
  });
});
