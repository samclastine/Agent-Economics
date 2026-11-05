import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    return bridge.app.handler(request);
  } catch (error) {
    console.error('[a423] unavailable:', error instanceof Error ? error.message : String(error));
    return Response.json(
      { error: { code: 'A423_UNAVAILABLE', message: 'A423 0.9 is not configured' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export { route as GET, route as POST };
