# A423 0.9 Operational Integration

Package: `@allorc/a423-sdk@0.9.0` (exact, npm).

Integrity: `sha512-2XK8SP8rA3hRNoXvzkJzN3eLvyyCzwoBtn1gUvUhp7TLaQhUVS6j6M93/VYcwxj64mLgYSDovJ/0vl21MFiu/A==`

0.9 adds flat per-agent mandates and retains the 0.8.1 profit policy and 0.6
cancellation subflow. No contract change: the 0.5 `A423Escrow` is still the
required reference contract.

The Robinhood Chain Testnet mock token's on-chain symbol is `tWIF`; the
product UI displays it as `$WIF`. This is a display label for the testnet demo
token, not a claim that it is mainnet WIF.

## Deployment

- Chain: Robinhood Chain Testnet, `46630`
- RPC: `https://rpc.testnet.chain.robinhood.com/rpc`
- Token: `0x8187DC056F36dF72694D1CA830c518FD5D542DbC` (`tWIF`, 18 decimals)
- A423Escrow 0.5: `0xB68E49bbAbE166c363447FbC7587310104ebdc75`
- Deployment tx: `0x01784a9aba9dd3a3df5d178fd7047e571785f7233d3ead4697801593d35f8a86`
- Indexer start block: `152232000`

## Mandates configured

`lib/a423/bridge04.ts` passes `mandates` into `createEscrowApplication` and
awaits `app.ready()` before the bridge is used.

| Agent | Actions | Budget | Lifetime |
|---|---|---|---|
| Agent A / buyer | `all` | `1,000 tWIF` total, `100 tWIF` per transaction, `500 tWIF` per UTC day, chain `46630`, token `0x8187DC056F36dF72694D1CA830c518FD5D542DbC` | 4 weeks from first registration |
| Agent B / worker | `all` | unlimited | lifetime |
| `a423-arbiter` | `all` | unlimited | lifetime |

Agent A's mandate ID is `robinhood-buyer-v2`. A restart reuses the original
registration deadline, fingerprint and budget reservations. Changing the
configured values under the same ID fails readiness; use a new ID for a
deliberate renewal or replacement.

Environment:

```bash
A423_MANDATE_A_ID=robinhood-buyer-v2
A423_MANDATE_A_TOTAL=1000000000000000000000
A423_MANDATE_A_PER_TX=100000000000000000000
A423_MANDATE_A_DAILY=500000000000000000000
A423_MANDATE_A_WEEKS=4
```

All amounts are raw integer token units. Omit `A423_MANDATE_A_*` only via a
deliberate config change and a new mandate ID; the mandate registration is
fingerprinted.

## What mandates enforce

- **Actions:** only the SDK action names allowed by the mandate. `all` includes
  `create`, `quote`, `accept`, `fund`, `start`, `submit`, `verify`, `release`,
  `refund`, `decline`, `reopen`, `cancel`, `expire`, `dispute`, `resolve`,
  `timeout`, `propose_settlement`, `counter_settlement`, `accept_settlement`,
  `approve_cancellation`, `execute_cancellation`.
- **Budget:** Agent A's funding principal is shared across jobs and escrow
  deployments in the configured chain/token. Per-transaction and daily caps are
  additional checks. Refunds do not automatically replenish the mandate budget;
  reservations are conservative commitment accounting, not net cash.
- **Lifetime:** new state-changing actions and signing/broadcast are denied at or
  after the registered expiry. Reads, receipts and observe-only reconciliation
  remain available under normal role checks.
- **Roles and signatures:** mandates do not replace authentication, participant
  roles, workflow state transitions, `approveSigning`, wallet signatures or the
  independent `limitsFor` spending policy. Both policies must permit a funding
  intent.

The reference factory automatically charges `fund` principal. Gas, AI provider
invoices, ordinary wallet transfers and transactions sent outside the SDK are
not metered by this mandate. The app's simulated AI cost meter is a separate
profit-policy input, not a mandate budget.

## Startup and worker

- `app.ready()` is awaited in `lib/a423/bridge04.ts` before serving.
- The worker passes `worker.canContinue` into `runExecutionOnce`, so expiry or
  action restrictions cooperatively abort active execution through the
  `AbortSignal`.
- `app.mandates.get(agentId)` and `app.mandates.list()` are backend inspection
  APIs. No public registration or edit endpoint is added.
- `limitsFor` remains configured as an additional wallet-level cap.

## Agent wait and loop safety

- `a423_wait_for_job` takes only `job_id`; it waits at most 15 seconds for a
  running job to leave the running state. It has no `until` or `timeout_ms`
  parameters.
- A terminal, refunded, expired or otherwise non-running job returns
  `WAIT_ALREADY_COMPLETED` immediately. A second wait for the same agent/job
  inside 15 seconds also returns `WAIT_ALREADY_COMPLETED`.
- Prompts require one wait per turn and forbid polling `a423_job_status` in a
  loop. `WAIT_TIMED_OUT` and `WORK_DEADLINE_PASSED` end the turn with a report.
- LangChain middleware hard-stops a turn after 16 model calls, 24 total tool
  calls, 2 wait calls, or 4 status/list calls. The third wait is an error, not
  another poll.
- The chat stream additionally aborts when assistant output repeats the same
  line or `<rfl:parameter>` block six times. This catches malformed function
  call syntax that never becomes a real tool call.
- Worker tick stages have independent timeouts, so one stalled SDK/RPC call
  cannot freeze execution queue processing indefinitely.

## Retained 0.8.1 profit policy

The SDK profit policy is still enabled:

- 50% target / 10% minimum / 50% maximum gross margin
- worker proposal default = capped target payout
- requester proposal default = full refund
- role-aware projections and private worker economics
- `/api/a423-profit/:id`
- `a423_settlement_policy` agent tool

## Retained cancellation subflow

The 0.6 staged cancellation flow is unchanged:

- propose/counter settlement
- both closing signatures
- saved instruction with `funds_status: not_executed`
- keeper/explicit execution
- confirmed final receipt only after matching on-chain evidence

The 0.7 decline/reopen pre-funding flow is also wired.

## Verification

- `npm run test` — **21/21** unit tests.
- Full Robinhood Testnet lifecycle: offer, accept, consent, fund, start, submit,
  verify and release.
- Malformed pending submit recovery through `workflow.rejectPendingOperation`.
- Worker/agent policy checks: worker sees private cost/profit; requester sees
  allocation and receipt confirmation only.
- `npx tsc --noEmit`, `npm run build`, `npm run lint`.

## Current Robinhood demo

- Agent A mandate: `all`, budget `1,000 tWIF` total / `100` per tx / `500`
  daily, 4 weeks, chain `46630`.
- Agent B and arbiter: `all`, unlimited, lifetime.
- Visible workflow:
  - `rh-e2e-1794476569089` — full lifecycle on Robinhood Testnet, paid in
    `tWIF`, receipt confirmed.

## Limits

- Mandates are off-chain policy, not on-chain signature revocation. They cannot
  reverse payouts, unlock escrow or stop an already broadcast transaction.
- Budget is a gross commitment cap; refunds do not replenish it automatically.
- The reference contract remains single-token, single-submission and one
  settlement; no milestones, fee-on-transfer/rebasing tokens or admin recovery.
- Robinhood Chain Testnet deployment only; no source verification or
  independent audit is implied.
- Old local/legacy deployments are not part of this app anymore.
