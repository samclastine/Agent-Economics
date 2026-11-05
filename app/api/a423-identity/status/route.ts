import { getDb } from '@/lib/db/client';
import { agents } from '@/lib/db/schema';
import { governorStatus, listRegistry } from '@/lib/a423/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only public identity registry view. It never creates or verifies anything. */
export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    const rows = await db.select().from(agents);
    const targets = rows.filter((a) => a.name === 'Agent A' || a.name === 'Agent B');
    const registry = listRegistry();
    const agentsOut = targets.map((a) => {
      const record = registry.find((r) => r.app_agent_id === a.id);
      const status = record ? governorStatus(a.id) : null;
      return {
        app_agent_id: a.id,
        agent_id: record?.agent_id ?? null,
        agent_name: a.name,
        org_id: record?.org_id ?? null,
        org_public_key: record?.org_public_key ?? null,
        agent_public_key: record?.agent_public_key ?? null,
        status: status?.verified ? 'verified' : 'pending',
        verified: status?.verified ?? false,
        expires_at: status?.expires_at ?? null,
      };
    });
    return Response.json({ ok: agentsOut.length >= 2 && agentsOut.every((a) => a.verified), agents: agentsOut }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[a423-identity] status failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ ok: false, error: 'identity registry unavailable' }, { status: 503 });
  }
}
