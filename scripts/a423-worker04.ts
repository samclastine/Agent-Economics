/**
 * Local durable A423 worker loop. Vercel runs the same tick from
 * /api/a423/worker via Vercel Cron (or a manual authenticated request).
 */
import 'dotenv/config';
import { runWorkerTick } from '../lib/a423/worker';

const once = process.env.A423_WORKER_ONCE === '1';
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });

async function main() {
  do {
    try {
      await runWorkerTick();
    } catch (error) {
      console.error('[a423-worker] tick failed', error instanceof Error ? error.message : String(error));
    }
    if (once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.A423_WORKER_INTERVAL_MS ?? 5000)));
  } while (!stopping);
}

main().catch((error) => { console.error('[a423-worker] fatal', error); process.exit(1); });
