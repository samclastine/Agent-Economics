import { JsonRpcProvider, Wallet, getAddress, verifyTypedData } from 'ethers';
import { workerConsent } from '@allorc/a423-sdk/escrow';
import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { getSignerPrivateKey } from '@/lib/chain/config';
import { resolveAgent, type ResolvedAgent } from './agents';

/** Dedicated non-chat arbitrator. The wallet key is separate from the agent's identity key. */
export function arbiterId(): string {
  return process.env.A423_ARBITER_ID ?? 'a423-arbiter';
}

export function arbiterSignerIndex(): number {
  const n = Number(process.env.A423_ARBITER_SIGNER_INDEX ?? 2);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('A423_ARBITER_SIGNER_INDEX is invalid');
  return n;
}

export async function resolveA423Actor(actorId: string): Promise<ResolvedAgent> {
  if (actorId === arbiterId()) {
    const index = arbiterSignerIndex();
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(getSignerPrivateKey(index));
    if (process.env.A423_ARBITER_ADDRESS && getAddress(process.env.A423_ARBITER_ADDRESS) !== getAddress(account.address)) {
      throw new Error('configured arbitrator address does not match the signer');
    }
    return { id: actorId, name: 'A423 Arbiter', wallet: getAddress(account.address) as `0x${string}`, signerIndex: index };
  }
  return resolveAgent(actorId);
}

export function createEthersProvider(): JsonRpcProvider {
  const rpc = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID ?? NaN);
  if (!rpc || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('RPC_URL/CHAIN_ID are not configured');
  return new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
}

export async function ethersSignerFor(actorId: string, provider?: JsonRpcProvider) {
  const actor = await resolveA423Actor(actorId);
  const wallet = new Wallet(getSignerPrivateKey(actor.signerIndex), provider ?? createEthersProvider());
  if (getAddress(wallet.address) !== getAddress(actor.wallet)) throw new Error('signer ownership mismatch');
  return wallet;
}

export async function ethersAddressFor(actorId: string): Promise<string> {
  return (await resolveA423Actor(actorId)).wallet;
}

/** Server-side demo consent: signs the exact EIP-712 terms the worker accepted. */
export async function signWorkerConsent(
  job: WorkflowJob,
  config: { chainId: number; contractAddress: string; tokenAddress: string },
): Promise<string> {
  const consent = workerConsent(job, config);
  const signer = await ethersSignerFor(job.participants.worker);
  const signature = await signer.signTypedData(consent.domain, consent.types, consent.value);
  const recovered = getAddress(verifyTypedData(consent.domain, consent.types, consent.value, signature));
  if (recovered !== getAddress(consent.value.worker)) throw new Error('worker consent signature mismatch');
  return signature;
}
