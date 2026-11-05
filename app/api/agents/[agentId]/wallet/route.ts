import { getWalletView } from '@/lib/wallet/service';
import { ok, fail } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await ctx.params;
    return ok(await getWalletView(agentId));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'error', 500);
  }
}
