import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Role-filtered profit policy projection and private worker economics. */
export async function GET(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    return bridge.app.handler(request);
  } catch (error) {
    console.error('[a423-profit] unavailable:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'profit policy unavailable' }, { status: 503 });
  }
}
