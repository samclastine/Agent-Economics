import { ok } from '@/lib/api';
import { chainName, getTokenMeta } from '@/lib/chain/config';

export const runtime = 'nodejs';

/** Public (non-secret) chain/app configuration for the dashboard header. */
export async function GET() {
  const meta = await getTokenMeta().catch(() => null);
  return ok({
    chainId: Number(process.env.CHAIN_ID ?? 46630),
    chainName,
    tokenSymbol: meta?.symbol ?? process.env.TOKEN_SYMBOL ?? 'tWIF',
    rpcUrl: process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com/rpc',
    mockWif: process.env.MOCK_WIF_ADDRESS ?? null,
    escrowAddress: process.env.A423_ESCROW_ADDRESS ?? null,
    tokenPriceUsd: process.env.DEMO_TOKEN_PRICE_USD ?? '0.02',
    demoMode: process.env.DEMO_MODE === 'true',
    explorerUrl: process.env.EXPLORER_URL ?? null,
  });
}
