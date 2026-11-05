import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    const handler = bridge.app.applicationOptions.authorityHandler;
    if (!handler) return Response.json({ error: 'authority handler unavailable' }, { status: 503 });
    return handler(request);
  } catch (error) {
    console.error('[a423-auth] unavailable:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'authority unavailable' }, { status: 503 });
  }
}

export { route as GET, route as POST };
