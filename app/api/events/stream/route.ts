import { subscribeEvents } from '@/lib/events';
import { getDb } from '@/lib/db/client';
import { agentEvents } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';

export const runtime = 'nodejs';

/** How many persisted events a fresh client replays to rebuild recent UI state. */
const REPLAY_LIMIT = 200;

// Cloudflare Quick Tunnels buffer SSE GET responses until the connection
// closes, but stream POST responses normally. Both verbs serve the same feed.
export async function POST(req: Request) {
  return GET(req);
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      // Subscribe before the replay query so no live event can fall into the
      // gap. Live events are buffered until the replay finishes, then flushed
      // in id order (skipping anything the replay already delivered).
      let replaying = true;
      let maxReplayId = 0;
      const buffered: { id: string; type: string; payload: unknown; agentId?: string; jobId?: string; runId?: string; createdAt: Date; ephemeral?: boolean }[] = [];
      const unsub = subscribeEvents((evt) => {
        if (replaying) { buffered.push(evt); return; }
        send(evt);
      });
      try {
        const db = getDb();
        // Latest events, not the oldest: a reopened dashboard wants the recent
        // conversation, and the client marks these as `replay` so old chat
        // mail isn't injected into whichever session happens to be open.
        const recent = await db.select().from(agentEvents).orderBy(desc(agentEvents.id)).limit(REPLAY_LIMIT);
        for (const r of recent.reverse()) {
          maxReplayId = r.id;
          send({
            id: r.id.toString(), type: r.type, payload: r.payloadJson,
            agentId: r.agentId, jobId: r.jobId, runId: r.runId, createdAt: r.createdAt,
            replay: true,
          });
        }
      } catch { /* db may be unavailable */ }
      replaying = false;
      for (const evt of buffered) {
        if (!evt.ephemeral && Number(evt.id) <= maxReplayId) continue; // already replayed
        send(evt);
      }
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { clearInterval(keepalive); }
      }, 15000);
      req.signal.addEventListener('abort', () => {
        unsub();
        clearInterval(keepalive);
        try { controller.close(); } catch { /* noop */ }
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
