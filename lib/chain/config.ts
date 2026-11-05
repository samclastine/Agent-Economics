import { createPublicClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

export const chainId = Number(process.env.CHAIN_ID ?? 46630);

export const explorerUrl = process.env.EXPLORER_URL ?? null;

const CHAIN_NAMES: Record<number, string> = {
  4663: 'Robinhood Chain',
  46630: 'Robinhood Chain Testnet',
};

export const chainName = process.env.CHAIN_NAME ?? CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

export const demoChain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com/rpc'] } },
  ...(explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: explorerUrl } } } : {}),
});

export function publicClient() {
  return createPublicClient({
    chain: demoChain,
    transport: http(process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com/rpc'),
  });
}

/**
 * Demo signer registry. Keys come from DEMO_SIGNER_KEYS (comma separated).
 * Agents never see these; the backend binds agentId -> signer index.
 */
export function getSignerPrivateKey(index: number): `0x${string}` {
  const keys = (process.env.DEMO_SIGNER_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('DEMO_SIGNER_KEYS is required; no built-in signer keys are used');
  return keys[index % keys.length] as `0x${string}`;
}

export function getSigner(index: number) {
  return privateKeyToAccount(getSignerPrivateKey(index));
}


type TokenMeta = { address: Address; decimals: number; symbol: string };
let tokenMetaCache: (TokenMeta & { at: number }) | null = null;

export async function getTokenMeta(): Promise<TokenMeta> {
  const address = (process.env.MOCK_WIF_ADDRESS ?? '0x0000000000000000000000000000000000000000') as Address;
  const now = Date.now();
  if (tokenMetaCache && tokenMetaCache.address.toLowerCase() === address.toLowerCase() && now - tokenMetaCache.at < 60_000) {
    return tokenMetaCache;
  }
  const fallbackSymbol = process.env.TOKEN_SYMBOL ?? (chainId === 4663 ? 'WIF' : 'tWIF');
  let decimals = 18;
  let symbol = fallbackSymbol;
  try {
    const pc = publicClient();
    const [d, s] = await Promise.all([
      pc.readContract({
        address,
        abi: [
          {
            name: 'decimals', type: 'function', stateMutability: 'view',
            inputs: [], outputs: [{ name: '', type: 'uint8' }],
          },
        ] as const,
        functionName: 'decimals',
      }),
      pc.readContract({
        address,
        abi: [
          {
            name: 'symbol', type: 'function', stateMutability: 'view',
            inputs: [], outputs: [{ name: '', type: 'string' }],
          },
        ] as const,
        functionName: 'symbol',
      }),
    ]);
    decimals = Number(d);
    symbol = String(s);
  } catch {
    // token not deployed yet; use fallback metadata
  }
  tokenMetaCache = { address, decimals, symbol, at: now };
  return tokenMetaCache;
}
