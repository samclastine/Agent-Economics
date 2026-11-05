import { freshReceipts, renderReceiptPdf } from '@allorc/a423-sdk/operations';
import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: raw } = await ctx.params;
  const pdf = raw.endsWith('.pdf');
  const id = pdf ? raw.slice(0, -4) : raw;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    const bridge = await getA423Bridge();
    const actor = await bridge.authenticator(request);
    if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const receipt = await freshReceipts({
      workflow: bridge.app.workflow,
      id,
      actor,
      revalidate: bridge.app.applicationOptions.revalidate,
    });
    if (pdf) {
      const bytes = await renderReceiptPdf(receipt);
      return new Response(Buffer.from(bytes), {
        headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' },
      });
    }
    return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[a423] receipt failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'receipt evidence unavailable or invalid' }, { status: 503 });
  }
}
