import { getDb } from '@/lib/db/client';
import { agents } from '@/lib/db/schema';
import { asc } from 'drizzle-orm';
import { ok, fail } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status, createdAt: agents.createdAt })
      .from(agents)
      .orderBy(asc(agents.createdAt));
    return ok({ agents: rows });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'error', 500);
  }
}
