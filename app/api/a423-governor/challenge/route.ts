import { authenticateBearer } from '@/lib/a423/auth';
import { createChallenge, GovernorError } from '@/lib/a423/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const actor = authenticateBearer(request);
  if (!actor) {
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, { status: 401 });
  }
  let body: { agent_id?: string };
  try {
    body = (await request.json()) as { agent_id?: string };
  } catch {
    return Response.json({ error: { code: 'INVALID_INPUT', message: 'JSON body required' } }, { status: 400 });
  }
  if (!body.agent_id || body.agent_id !== actor) {
    return Response.json({ error: { code: 'FORBIDDEN', message: 'agent_id must match the authenticated agent' } }, { status: 403 });
  }
  try {
    return Response.json(createChallenge(body.agent_id), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof GovernorError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return Response.json({ error: { code: 'GOVERNOR_ERROR', message: 'Challenge could not be created' } }, { status: 503 });
  }
}
