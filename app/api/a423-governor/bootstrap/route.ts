import { bootstrapDevIdentities } from '@/lib/a423/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard mount bootstrap. Development-only: it generates local keys and
 * verifies the seeded agents with the local governor. Disabled unless
 * A423_ALLOW_BOOTSTRAP=true. Never returns private material.
 */
export async function POST(): Promise<Response> {
  if (process.env.A423_ALLOW_BOOTSTRAP !== 'true') {
    return Response.json(
      { error: { code: 'BOOTSTRAP_DISABLED', message: 'A423 bootstrap is disabled; run npm run a423:identity && npm run a423:verify' } },
      { status: 403 },
    );
  }
  try {
    const result = await bootstrapDevIdentities();
    const ready = result.agents.length >= 2 && result.agents.every((a) => a.verified);
    return Response.json({ ok: ready, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[a423] bootstrap failed:', error instanceof Error ? error.message : String(error));
    return Response.json(
      { error: { code: 'BOOTSTRAP_FAILED', message: 'Could not create or verify agent identities' } },
      { status: 500 },
    );
  }
}
