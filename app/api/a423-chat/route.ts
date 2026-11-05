import { chatToolCall } from '@/lib/a423/chat04';
import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    const actor = await bridge.authenticator(request);
    if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const body = (await request.json()) as { tool?: string; input?: Record<string, unknown> };
    if (!body.tool) return Response.json({ error: 'tool required' }, { status: 400 });
    // Actor comes only from the verified credential; never from body.input.
    const job = await chatToolCall(actor, body.tool, body.input ?? {});
    return Response.json({ job }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[a423-chat] failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: error instanceof Error ? error.message : 'chat tool failed' }, { status: 400 });
  }
}
