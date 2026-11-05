import { loadGovernorConfig } from '@/lib/a423/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const config = loadGovernorConfig();
    return Response.json(
      {
        version: config.version,
        governor: config.governor,
        organizations: config.organizations.map((o) => ({
          org_id: o.org_id,
          name: o.name,
          public_key: o.public_key,
          agent: {
            agent_id: o.agent.agent_id,
            app_agent_id: o.agent.app_agent_id,
            agent_reference: o.agent.agent_reference,
            agent_name: o.agent.agent_name,
            agent_email: o.agent.agent_email,
            agent_public_key: o.agent.agent_public_key,
          },
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json({ error: { code: 'GOVERNOR_UNAVAILABLE', message: 'Governor is not configured' } }, { status: 503 });
  }
}
