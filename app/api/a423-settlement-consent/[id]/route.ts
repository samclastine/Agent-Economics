import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated ClosingSettlement typed data. The party signs it with its own wallet. */
export async function GET(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    return bridge.app.handler(request);
  } catch (error) {
    console.error('[a423-settlement-consent] unavailable:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'settlement consent unavailable' }, { status: 503 });
  }
}
