import { ok, fail } from '@/lib/api';
import { publicClient } from '@/lib/chain/config';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  try {
    const { hash } = await ctx.params;
    const pc = publicClient();
    const receipt = await pc.getTransactionReceipt({ hash: hash as `0x${string}` });
    return ok({
      hash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      logs: receipt.logs.length,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'not found', 404);
  }
}
