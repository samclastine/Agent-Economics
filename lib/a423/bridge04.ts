import { readFileSync } from 'fs';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
import { createAuthority, createCredentialAuthenticator } from '@allorc/a423-sdk/authority';
import { createEscrowApplication } from '@allorc/a423-sdk/operations';
import { createHash } from 'crypto';
import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { getDb } from '@/lib/db/client';
import { agentWallets, agents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSignerPrivateKey } from '@/lib/chain/config';
import { usdCentsToTokenRaw } from '@/lib/finance/money';
import { computeWorkMeter, defaultWorkMeterConfig, type WorkMeter } from './work-meter-core';
import { validateArtifact as validateArtifactSpec } from '@/lib/artifacts/validators';
import { generateJobFiles, scriptedContent } from '@/lib/a423/artifact-templates';
import { getLatestWorkflowArtifact, storeWorkflowArtifact } from './operations';

export type A423Bridge = Awaited<ReturnType<typeof buildBridge>>;
const globalForBridge = globalThis as unknown as { __a423Bridge04?: Promise<A423Bridge> };

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`A423: ${name} is required`);
  return v;
}

function rawLimit(name: string, fallback: string): string {
  const v = process.env[name] ?? fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`A423: ${name} must be a raw integer string`);
  return v;
}

function marginBps(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 0 && value < 10000 ? value : fallback;
}

function mandateAmount(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`A423: ${name} must be a raw integer string`);
  return value;
}

function mandateWeeks(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`A423: ${name} must be a positive integer`);
  return value;
}

async function walletFor(actor: string, provider: JsonRpcProvider): Promise<{ wallet: Wallet; address: string }> {
  const arbiter = process.env.A423_ARBITER_ID ?? 'a423-arbiter';
  if (actor === arbiter) {
    const keyFile = required('A423_ARBITER_WALLET_KEY_PATH');
    const privateKey = (JSON.parse(readFileSync(keyFile, 'utf8')) as { private_key: string }).private_key;
    const wallet = new Wallet(privateKey, provider);
    return { wallet, address: getAddress(wallet.address) };
  }
  const db = getDb();
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, actor) });
  if (!agent || agent.status !== 'active') throw new Error('unknown Agent actor');
  const row = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, actor) });
  if (!row || row.paused) throw new Error('agent wallet unavailable');
  const match = /^(?:demo-)?signer:(\d{1,3})$/.exec(row.keyReference ?? '');
  if (!match) throw new Error('agent wallet has no explicit signer binding');
  const wallet = new Wallet(getSignerPrivateKey(Number(match[1])), provider);
  if (getAddress(wallet.address) !== getAddress(row.address)) throw new Error('signer does not match registered wallet');
  return { wallet, address: getAddress(row.address) };
}

async function buildBridge() {
  const chainId = Number(required('A423_CHAIN_ID'));
  const rpc = required('A423_RPC_URL');
  const tokenAddress = getAddress(required('A423_TOKEN_ADDRESS'));
  const escrowAddress = getAddress(required('A423_ESCROW_ADDRESS'));
  const confirmations = Number(process.env.A423_CONFIRMATIONS ?? 1);
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('A423_CONFIRMATIONS invalid');
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });

  const storage = createSqliteStorage({ filename: process.env.A423_STORAGE_FILE ?? 'data/a423-operations.sqlite' });
  const authority = createAuthority({
    issuer: process.env.A423_AUTHORITY_ISSUER ?? 'a423-local-authority',
    audience: process.env.A423_AUTHORITY_AUDIENCE ?? 'a423-local-app',
    privateKey: readFileSync(required('A423_AUTHORITY_KEY_PATH'), 'utf8'),
    kv: storage.kv,
    credentialTtlSeconds: Number(process.env.A423_CREDENTIAL_TTL_SECONDS ?? 3600),
  });

  const agentRows = await getDb().select().from(agents);
  const agentA = agentRows.find((agent) => agent.name === 'Agent A');
  const agentB = agentRows.find((agent) => agent.name === 'Agent B');
  const arbiterId = process.env.A423_ARBITER_ID ?? 'a423-arbiter';

  const app = createEscrowApplication({
    storage,
    authority,
    escrows: [{ provider, chainId, contractAddress: escrowAddress, tokenAddress, confirmations }],
    mandates: [
      ...(agentA ? [{
        agentId: agentA.id,
        id: process.env.A423_MANDATE_A_ID ?? 'local-buyer-v1',
        actions: 'all' as const,
        budget: {
          chainId,
          tokenAddress,
          total: mandateAmount('A423_MANDATE_A_TOTAL', (2000n * 10n ** 18n).toString()),
          perTransaction: mandateAmount('A423_MANDATE_A_PER_TX', (100n * 10n ** 18n).toString()),
          daily: mandateAmount('A423_MANDATE_A_DAILY', (500n * 10n ** 18n).toString()),
        },
        duration: { weeks: mandateWeeks('A423_MANDATE_A_WEEKS', 4) },
      }] : []),
      ...(agentB ? [{ agentId: agentB.id, actions: 'all' as const }] : []),
      { agentId: arbiterId, actions: 'all' as const },
    ],
    signerFor: async (actor) => (await walletFor(actor, provider)).wallet,
    addressFor: async (actor) => (await walletFor(actor, provider)).address,
    limitsFor: async () => ({
      perTransaction: rawLimit('A423_LIMIT_PER_TX', (1000n * 10n ** 18n).toString()),
      daily: rawLimit('A423_LIMIT_DAILY', (5000n * 10n ** 18n).toString()),
      total: rawLimit('A423_LIMIT_TOTAL', (20000n * 10n ** 18n).toString()),
    }),
    approveSigning: async (context) => {
      if (process.env.A423_ALLOW_SIGNING !== 'true') return false;
      if (!(await authority.isActive(context.actor))) return false;
      return Object.values(context.job.participants).includes(context.actor);
    },
    validateArtifact: async ({ job, resultHash }) => {
      const terms = job.agreement?.terms as unknown as Record<string, unknown>;
      const path = typeof terms.artifact_path === 'string' ? terms.artifact_path : null;
      if (!path) return false;
      const artifact = getLatestWorkflowArtifact(job.id);
      if (!artifact) return false;
      const actual = `0x${createHash('sha256').update(artifact.content).digest('hex')}`;
      if (actual.toLowerCase() !== resultHash.toLowerCase()) return false;
      if (artifact.path !== path) return false;
      const task = terms.task as { acceptance?: { criteria?: Record<string, unknown> } } | undefined;
      const criteria = { ...(task?.acceptance?.criteria ?? {}), path };
      const result = validateArtifactSpec({
        path: artifact.path,
        content: artifact.content.toString('utf8'),
        acceptanceSpec: criteria,
      });
      return result.passed;
    },
    execute: async ({ job, idempotencyKey, signal }) => {
      if (signal?.aborted) throw new Error('execution aborted: workflow is paused for cancellation negotiation');
      const escrow = (job.agreement?.terms as Record<string, unknown> | undefined)?.escrow as Record<string, unknown> | undefined;
      const workDeadline = Number(escrow?.work_deadline);
      if (Number.isFinite(workDeadline)) {
        const pending = await provider.getBlock('pending');
        const chainNow = pending?.timestamp ?? Math.floor(Date.now() / 1000);
        if (chainNow >= workDeadline) {
          throw new Error('work deadline passed; submission is no longer possible; the requester must refund');
        }
      }
      const existing = getLatestWorkflowArtifact(job.id);
      if (existing) {
        return { result_hash: `0x${existing.sha256}`, artifact_id: existing.id, artifact_path: existing.path, execution_key: idempotencyKey };
      }
      const terms = job.agreement?.terms as unknown as Record<string, unknown>;
      const task = terms.task as { type?: string; description?: string } | undefined;
      const path = typeof terms.artifact_path === 'string' ? terms.artifact_path : '/report.md';
      const description = task?.description ?? 'A423 workflow deliverable';
      const type = (task?.type ?? 'research') as Parameters<typeof generateJobFiles>[0];
      const generated = generateJobFiles(type, description).find((f) => f.path === path)
        ?? { path, content: scriptedContent(path, description) };
      if (signal?.aborted) throw new Error('execution aborted: workflow is paused for cancellation negotiation');
      const artifact = storeWorkflowArtifact({
        jobId: job.id,
        agentId: job.participants.worker,
        path: generated.path,
        content: Buffer.from(generated.content, 'utf8'),
        manifest: { execution_key: idempotencyKey, task_type: task?.type ?? 'research', generator: 'a423-09-demo' },
      });
      return { result_hash: `0x${artifact.sha256}`, artifact_id: artifact.id, artifact_path: artifact.path, execution_key: idempotencyKey };
    },
    settlementPolicy: {
      thresholds: {
        target_margin_bps: marginBps('A423_TARGET_MARGIN_BPS', 5000),
        min_margin_bps: marginBps('A423_MIN_MARGIN_BPS', 1000),
        max_margin_bps: marginBps('A423_MAX_MARGIN_BPS', 5000),
        require_counter: process.env.A423_REQUIRE_COUNTER !== 'false',
      },
      costBasisFor: async (job) => {
        // The app work meter freezes at the first closing proposal. Prefer that
        // durable snapshot; fall back to a live mock calculation for direct
        // HTTP proposals that did not pass through the chat wrapper.
        const stored = await storage.kv.get('a423:work-meter', job.id) as WorkMeter | null;
        if (stored?.cost_basis_raw) return stored.cost_basis_raw;
        if (stored?.recovery_raw) return stored.recovery_raw;
        return computeWorkMeter(job, Date.now(), defaultWorkMeterConfig()).cost_basis_raw;
      },
      budgetFor: async (job) => {
        const metadata = job.metadata as Record<string, unknown> | undefined;
        const cents = Number(metadata?.budget_usd_cents);
        if (Number.isSafeInteger(cents) && cents > 0) {
          return usdCentsToTokenRaw(cents, process.env.DEMO_TOKEN_PRICE_USD ?? '0.02', 18).toString();
        }
        const escrow = (job.agreement?.terms as Record<string, unknown> | undefined)?.escrow as Record<string, unknown> | undefined;
        return typeof escrow?.amount === 'string' ? escrow.amount : '0';
      },
    },
    keeperEnabled: process.env.A423_KEEPER_ENABLED !== 'false',
    // Stage HTTP acceptance, then let an explicitly enabled keeper forward the
    // accepted instruction through the durable worker loop.
    forwardCancellations: process.env.A423_FORWARD_CANCELLATIONS === 'true',
    allowAuthorityRequest: async () => process.env.A423_AUTH_ALLOW_ANY === 'true',
    requireIndependentArbitrator: true,
  });

  // Mandate registration is durable and fingerprinted. Await it before the
  // bridge serves any workflow, signing or worker request.
  await app.ready();

  const authenticator = createCredentialAuthenticator({ authority });
  const credentials = new Map<string, { credential: string; expires_at: number }>();
  async function credentialFor(actor: string): Promise<string> {
    const cached = credentials.get(actor);
    if (cached && cached.expires_at - Math.floor(Date.now() / 1000) > 60) return cached.credential;
    const keyFile = JSON.parse(readFileSync('.a423/a423-private-keys.json', 'utf8')) as { agents: Record<string, { private_key: string }> };
    const key = keyFile.agents[actor]?.private_key;
    if (!key) throw new Error(`no authority identity key for ${actor}`);
    const challenge = await authority.challenge(actor);
    const { sign, createPrivateKey } = await import('crypto');
    const signature = sign(null, Buffer.from(JSON.stringify(challenge)), createPrivateKey(key)).toString('base64url');
    const issued = await authority.exchange({ challengeId: challenge.id, signature });
    credentials.set(actor, issued);
    return issued.credential;
  }

  return {
    storage, authority, provider, app, authenticator, credentialFor,
    signerFor: async (actor: string) => (await walletFor(actor, provider)).wallet,
    escrowAddress, tokenAddress, chainId, confirmations,
  };
}

export function getA423Bridge(): Promise<A423Bridge> {
  if (!globalForBridge.__a423Bridge04) {
    globalForBridge.__a423Bridge04 = buildBridge().catch((error) => {
      delete globalForBridge.__a423Bridge04;
      throw error;
    });
  }
  return globalForBridge.__a423Bridge04;
}

export function componentForJob(job: WorkflowJob) {
  const terms = job.agreement?.terms as unknown as { artifact_path?: string } | undefined;
  return terms?.artifact_path ?? null;
}
