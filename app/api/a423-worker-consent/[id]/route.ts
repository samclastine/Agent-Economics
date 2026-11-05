import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns the EIP-712 typed data; the worker's wallet signs it. No server-side consent signature. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const bridge = await getA423Bridge();
    const actor = await bridge.authenticator(request);
    if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const job = await bridge.app.workflow.get(id, actor);
    if (job.participants.worker !== actor) return Response.json({ error: 'worker required' }, { status: 403 });
    const typed = await bridge.app.applicationOptions.consentFor!(job);
    return Response.json(
      JSON.parse(JSON.stringify(typed, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('[a423] consent failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'consent unavailable' }, { status: 503 });
  }
}
