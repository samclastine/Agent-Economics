# Vercel + Turso deployment

The app is now serverless-compatible for the database path:

- Local development: libSQL file at `data/agent-treasury.db`
- Vercel production: Turso via `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`
- A423 SDK storage, app entities, governor registry, queue, receipts and artifacts
  all use the same libSQL database.
- `/api/a423/worker` runs the worker tick; `vercel.json` schedules it every minute.
- `/api/events/stream` polls the durable event table, so it works across
  serverless instances.

## 1. Turso

```bash
TURSO_DATABASE_URL=libsql://demo-clastine.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=<secret>
```

The production database has already been initialized and migrated from the
current local state. Re-running the migration is idempotent:

```bash
npx tsx scripts/init-db.ts
npx tsx scripts/migrate-to-turso.ts
```

## 2. Vercel environment

Add these in **Project → Settings → Environment Variables** for Production:

### Required

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
A423_AGENT_TOKENS
DEMO_SIGNER_KEYS
OPENAI_API_KEY
OPENAI_BASE_URL
AGENT_MODEL

A423_CHAIN_ID=46630
A423_RPC_URL=https://rpc.testnet.chain.robinhood.com/rpc
A423_TOKEN_ADDRESS=0x8187DC056F36dF72694D1CA830c518FD5D542DbC
A423_ESCROW_ADDRESS=0xB68E49bbAbE166c363447FbC7587310104ebdc75
A423_ESCROW_VERSION=0.5
A423_CONFIRMATIONS=1
A423_INDEX_FROM_BLOCK=152232000
A423_MANDATE_A_ID=robinhood-buyer-v2
A423_DASHBOARD_ACTOR=4fe2890a-d392-453d-a27a-2f6c2fab6fad

A423_ALLOW_SIGNING=true
A423_SERVER_CONSENT=true
A423_AUTH_ALLOW_ANY=false
A423_ALLOW_BOOTSTRAP=false
A423_REQUIRE_VERIFIED_AGENTS=true
A423_CHAT_MODE=sdk
A423_KEEPER_ENABLED=true
A423_FORWARD_CANCELLATIONS=false

A423_EVIDENCE_REVALIDATION=off
A423_WORKER_UI=true
CRON_SECRET=<long random secret>
```

### Key material

These replace the local `.a423/` files on Vercel:

```text
A423_AUTHORITY_KEY_PEM=<contents of .a423/authority-04.pem>
A423_PRIVATE_KEYS_JSON=<contents of .a423/a423-private-keys.json>
A423_ARBITER_PRIVATE_KEY=<private_key from .a423/arbiter-04-wallet.json>
```

Do **not** commit these values. They are already present in the local
`.env.production.local`/`.a423` files for testing.

## 3. Deploy

```bash
npm run build
# push to GitHub; Vercel builds from main
```

`vercel.json` registers a daily cron backup (Hobby-safe). While the dashboard is
open, the browser also POSTs `/api/a423/worker` every 60 seconds, so the queue
keeps moving without another server. On Vercel Pro, change the schedule to
`* * * * *`.

Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the route rejects
unauthorized cron requests when `CRON_SECRET` is set. UI POSTs are allowed while
`A423_WORKER_UI=true`.

## 4. Known constraints

- **Evidence revalidation is off.** The public Robinhood RPC does not serve
  historical `eth_call` state, so `getJob` at an old block reverts. Receipts and
  the worker use stored evidence with `A423_EVIDENCE_REVALIDATION=off`. Use an
  archive RPC to turn revalidation back on.
- **Chat checkpoints are in-memory.** Vercel may route turns to different
  instances; long multi-turn agent memory is not guaranteed. The active-workflow
  snapshot is rebuilt from Turso each turn, and the UI chat history is durable.
- **Cron frequency.** The default daily cron is Hobby-safe. The open dashboard
  triggers the worker every minute; for headless operation on Pro, use `* * * * *`.
- **Server-side signing.** `A423_SERVER_CONSENT=true` is a testnet demo
  convenience, not a production custody model.
- **Testnet only.** The token is mock `tWIF`, displayed as `$WIF`; it is not
  mainnet WIF. The A423 escrow is not source-verified or audited.
