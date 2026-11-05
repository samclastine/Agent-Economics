import { createEventStream } from '@allorc/a423-sdk/operations';
import { getA423Bridge } from '@/lib/a423/bridge04';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const bridge = await getA423Bridge();
    const stream = createEventStream({
      store: bridge.storage.jobs,
      authenticate: bridge.app.applicationOptions.authenticate,
    });
    return stream(request);
  } catch (error) {
    console.error('[a423-events] unavailable:', error instanceof Error ? error.message : String(error));
    return Response.json({ error: 'event stream unavailable' }, { status: 503 });
  }
}
