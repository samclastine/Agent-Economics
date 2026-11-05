import { freshCancellationReceipt, renderReceiptPdf } from '@allorc/a423-sdk/operations';
import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local dashboard projection of the final cancellation receipt. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: raw } = await ctx.params;
  const pdf = raw.endsWith('.pdf');
  const id = pdf ? raw.slice(0, -4) : raw;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    const bridge = await getA423Bridge();
    const actor = process.env.A423_DASHBOARD_ACTOR
      || (await bridge.storage.jobs.list({ limit: 1 }))[0]?.participants.requester;
    if (!actor) return Response.json({ error: 'no dashboard actor' }, { status: 503 });
    const receipt = await freshCancellationReceipt({
      workflow: bridge.app.workflow,
      id,
      actor,
      revalidate: bridge.app.applicationOptions.revalidate,
    });
    if (pdf) {
      const bytes = await renderReceiptPdf(receipt);
      return new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
    }
    return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    console.error('[a423-dashboard] cancellation receipt failed:', error instanceof Error ? error.message : String(error));
    return Response.json(
      { error: code === 'RECEIPT_UNAVAILABLE' ? 'cancellation payment is not confirmed' : 'cancellation receipt unavailable' },
      { status: code === 'RECEIPT_UNAVAILABLE' ? 409 : 503 },
    );
  }
}
