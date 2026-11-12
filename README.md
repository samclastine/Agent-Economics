# Agent-Economics

**Agent Treasury — A423 escrow agent marketplace on Robinhood Chain Testnet.**

Two autonomous agents negotiate work, lock payment in escrow, execute, verify,
and settle on **Robinhood Chain Testnet**. The app uses
`@allorc/a423-sdk@0.9.0` for workflow state, mandates, escrow operations,
profit policy, cancellation, receipts and the durable worker.

## Chain

| Item | Value |
|---|---|
| Network | Robinhood Chain Testnet |
| Chain ID | `46630` |
| RPC | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |
| Token | `0x8187DC056F36dF72694D1CA830c518FD5D542DbC` (`tWIF`, 18 decimals) |
| A423Escrow 0.5 | `0xB68E49bbAbE166c363447FbC7587310104ebdc75` |
| Deployment tx | `0x01784a9aba9dd3a3df5d178fd7047e571785f7233d3ead4697801593d35f8a86` |

The UI displays the testnet mock token `tWIF` as `$WIF`. It is not mainnet WIF.

## What is implemented

- Agent-to-agent offers, counteroffers, acceptance, funding, work, submission,
  verification and release.
- On-chain `A423Escrow` custody with role and deadline enforcement.
- SDK mandates: Agent A is capped by total, per-transaction and daily budgets;
  Agent B and the arbiter are unlimited.
- SDK profit policy: 50% target / 10% minimum / 50% maximum gross margin, with
  projected and realized profit shown in the dashboard.
- Cancellation/closing settlement subflow with work meter, signed consent,
  keeper forwarding and final receipts.
- Durable worker queue, SDK indexer, evidence reconciliation and webhook hooks.
- Dashboard: A423 workflows, expandable job cards, agent chat, wallet balances,
  locked escrow, profit policy, work meter and JSON/PDF receipts.

## Setup

```bash
npm install
cp .env.example .env
# fill OPENAI_API_KEY, DEMO_SIGNER_KEYS, A423_AGENT_TOKENS,
# A423_ESCROW_ADDRESS and A423_INDEX_FROM_BLOCK

npx tsx scripts/init-db.ts
npx tsx scripts/seed.ts
npm run a423:identity
npm run a423:verify
npm run dev
```

Run the worker separately:

```bash
npm run a423:worker04
```

## Scripts

```bash
npm run dev                 # Next.js dashboard
npm run a423:worker04       # durable queue, execution, indexer, keeper
npm run test                # vitest
npm run build               # production build
npx tsx scripts/seed.ts     # ensure Agent A/B and signer-bound wallets
npx tsx scripts/deploy-a423-escrow.ts   # dry-run unless A423_DEPLOY_CONFIRM=I_UNDERSTAND
```

## Environment

The important settings are in `.env.example`:

- `CHAIN_ID=46630`, `RPC_URL`, `MOCK_WIF_ADDRESS`
- `A423_CHAIN_ID=46630`, `A423_RPC_URL`, `A423_TOKEN_ADDRESS`,
  `A423_ESCROW_ADDRESS`
- `A423_MANDATE_A_ID=robinhood-buyer-v2` and the mandate caps
- `A423_SERVER_CONSENT=true` for the autonomous testnet demo
- `A423_INDEX_FROM_BLOCK=152232000`

`A423_SERVER_CONSENT` lets the backend sign worker/settlement consent with the
agent’s configured signer. It is a testnet demo convenience, not a production
custody model.

## Vercel + Turso

See [`docs/VERCEL.md`](docs/VERCEL.md) for the production environment,
Turso migration, cron worker and current constraints.

## Limits

- Robinhood Chain **testnet only**; the token is a mock `tWIF`.
- The A423 escrow deployment has **not** been source-verified and is not audited.
- The public Robinhood RPC does not serve historical `eth_call` state, so production
  receipts/worker evidence use `A423_EVIDENCE_REVALIDATION=off` (stored evidence,
  no historical revalidation). Use an archive RPC to enable full revalidation.
- Agent signing keys are server-side in this demo. Do not reuse this custody
  model for real funds.
- Mandates are off-chain policy; they cannot reverse a broadcast transaction.
- The reference escrow is single-token, single-submission and one settlement;
  no milestones, fee-on-transfer/rebasing tokens or admin recovery.
