import { governorStatus } from '@/lib/a423/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) {
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, { status: 404 });
  }
  try {
    const status = governorStatus(agentId);
    return Response.json(status, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: { code: 'GOVERNOR_UNAVAILABLE', message: 'Governor is not configured' } }, { status: 503 });
  }
}
