import { freshReceipts, renderReceiptPdf } from '@allorc/a423-sdk/operations';
import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local dashboard projection: uses the configured dashboard actor, not a browser credential. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const bridge = await getA423Bridge();
    const actor = process.env.A423_DASHBOARD_ACTOR || (await bridge.storage.jobs.list({ limit: 1 }))[0]?.participants.requester;
    if (!actor) return Response.json({ error: 'no dashboard actor' }, { status: 503 });
    const receipt = await freshReceipts({
      workflow: bridge.app.workflow,
      id,
      actor,
      revalidate: bridge.app.applicationOptions.revalidate,
    });
    if (new URL(request.url).searchParams.get('format') === 'pdf') {
      const bytes = await renderReceiptPdf(receipt);
      return new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
    }
    return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[a423-dashboard] receipt failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'receipt unavailable' }, { status: 503 });
  }
}
