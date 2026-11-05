import { authenticateBearer } from '@/lib/a423/auth';
import { GovernorError, verifyChallenge } from '@/lib/a423/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const actor = authenticateBearer(request);
  if (!actor) {
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, { status: 401 });
  }
  let body: { agent_id?: string; challenge_id?: string; code?: string; signature?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: { code: 'INVALID_INPUT', message: 'JSON body required' } }, { status: 400 });
  }
  if (!body.agent_id || body.agent_id !== actor) {
    return Response.json({ error: { code: 'FORBIDDEN', message: 'agent_id must match the authenticated agent' } }, { status: 403 });
  }
  if (!body.challenge_id || !body.code || !body.signature) {
    return Response.json({ error: { code: 'INVALID_INPUT', message: 'challenge_id, code and signature are required' } }, { status: 400 });
  }
  try {
    const result = verifyChallenge({
      appAgentId: body.agent_id,
      challengeId: body.challenge_id,
      code: body.code,
      signature: body.signature,
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof GovernorError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return Response.json({ error: { code: 'GOVERNOR_ERROR', message: 'Verification failed' } }, { status: 400 });
  }
}
