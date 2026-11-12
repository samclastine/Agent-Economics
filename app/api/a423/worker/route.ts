import { ok, fail } from '@/lib/api';
import { runWorkerTick } from '@/lib/a423/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const isCron = req.method === 'GET';
  const authorized = !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
  if (isCron && secret && !authorized) return fail('unauthorized', 401);
  if (!isCron && !authorized && process.env.A423_WORKER_UI === 'false') return fail('unauthorized', 401);
  try {
    await runWorkerTick();
    return ok({ ok: true, at: new Date().toISOString() });
  } catch (error) {
    console.error('[a423-worker-route] failed:', error instanceof Error ? error.message : String(error));
    return fail(error instanceof Error ? error.message : 'worker tick failed', 500);
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
