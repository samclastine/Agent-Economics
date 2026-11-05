# A423 Profit-Driven Settlement Policy — Recommendation

**Status:** implemented in `@allorc/a423-sdk@0.8.1`; this document remains the design rationale.  
**Audience:** implementation agent, SDK maintainer, product owner  
**Baseline:** `@allorc/a423-sdk@0.9.0`, 0.5 `A423Escrow`, Robinhood Chain Testnet  
**Important:** the SDK now ships `/policy`, `settlementPolicy`, target/minimum/maximum thresholds, role-aware projections, owner exceptions and supported malformed-pending recovery. The app is wired to those SDK primitives; the mock cost meter remains app-side.

---

## 1. TL;DR

- **Profit is the primary objective**, not merely cost recovery.
- Target **50% gross margin on revenue**:
  - `profit = payout − cost_basis`
  - `gross_margin = profit / payout`
  - `target_payout = cost_basis / (1 − 0.50) = 2 × cost_basis`
- **Maximum target:** 50% margin. Do not ask for more even if the buyer’s budget allows it.
- **Minimum:** never below cost. Require a positive minimum margin (recommended 10%) or an explicit owner-approved loss.
- **If the budget cannot support 50%:** negotiate the highest positive margin available.
- **If the budget is below cost:** decline, cancel, or require explicit owner approval.
- **SDK:** add generic policy primitives (`CostBasisProvider`, `SettlementPolicy`, profit projection, policy prompt fragment, supported pending recovery).
- **App:** keep the mock token counter, specific 50% target, business configuration and UI.
- **Contract:** do **not** put cost or profit logic in `A423Escrow`. The contract only enforces the agreed worker/payer split.

---

## 2. Definitions

| Term | Definition |
|---|---|
| `cost_basis_raw` | Simulated/actual AI usage cost plus agreed expenses, converted to escrow-token raw units |
| `payout_raw` | Worker allocation in the closing settlement |
| `profit_raw` | `payout_raw − cost_basis_raw` |
| `gross_margin` | `profit_raw / payout_raw` |
| `markup` | `profit_raw / cost_basis_raw` |
| `target_margin_bps` | Desired gross margin in basis points; default `5000` = 50% |
| `min_margin_bps` | Minimum acceptable gross margin; recommended `1000` = 10% |
| `max_margin_bps` | Maximum ask; default `5000` = 50% |
| `budget_raw` | Maximum the requester is willing to pay, from job metadata |
| `escrow_raw` | Total funded amount currently locked |

### Why gross margin, not markup?

“50% profit” can mean:

- **50% markup:** `payout = 1.5 × cost` → profit is 50% of cost, 33.3% of revenue.
- **50% gross margin:** `payout = 2 × cost` → profit is 100% of cost, 50% of revenue.

This document recommends **gross margin on revenue** because:

- it matches the intuitive “profit percentage” shown in a UI;
- it gives a stronger but still capped target;
- it makes the “maximum 50%” rule unambiguous.

If the product wants markup instead, change one configuration value, not the whole policy.

---

## 3. Policy rules

### Inputs

- `cost_basis_raw` — supplied by the app’s cost meter.
- `budget_raw` — requester’s maximum, from job metadata.
- `escrow_raw` — total currently locked.
- `target_margin_bps` — default `5000`.
- `min_margin_bps` — default `1000`.
- `max_margin_bps` — default `5000`.

### Computed values

```text
target_payout = ceil(cost_basis / (1 − target_margin))
min_payout    = ceil(cost_basis / (1 − min_margin))
max_payout    = ceil(cost_basis / (1 − max_margin)) = 2 × cost at 50%
affordable    = min(budget_raw, escrow_raw)
```

### Decision table

| Situation | Action |
|---|---|
| No work completed (`cost_basis = 0`) | Full refund is appropriate; worker amount `0` |
| `affordable < cost_basis` | Decline / cancel / require explicit owner approval. Do not accept a loss silently |
| `cost_basis ≤ affordable < min_payout` | Negotiate at least cost; below minimum margin requires owner approval |
| `min_payout ≤ affordable < target_payout` | Counter at `affordable`; settle only above the minimum margin |
| `affordable ≥ target_payout` | Ask `target_payout`; cap at 50% margin, not more |
| Buyer offers below cost | Counter at `min_payout` or decline |
| Buyer offers between cost and target | Counter toward target; do not accept the first offer |
| Buyer offers target or above | Accept only if the exact revision/hash is correct and the receipt will be confirmed |

### Example with current demo values

Current simulated meter at 29% progress:

```text
cost_basis = 6.00505 tWIF
target 50% margin → payout = 12.0101 tWIF
profit = 6.00505 tWIF
margin = 50.00%
min 10% margin → payout = 6.67228 tWIF
max ask = 12.0101 tWIF
```

Budget scenarios:

| Budget | Maximum achievable margin | Recommended action |
|---:|---:|---|
| 50.00 tWIF | 50% target affordable | Ask 12.0101, cap there |
| 8.00 tWIF | 24.94% | Counter at 8.00; accept only above 10% |
| 6.50 tWIF | 7.61% | Below minimum margin; owner approval or decline |
| 5.50 tWIF | negative | Decline; budget is below cost |

### Rounding

- Use raw integer token units.
- Round target/minimum payouts **up** to protect margin.
- Never exceed `min(budget_raw, escrow_raw)`.
- Never produce a negative allocation.
- If rounding produces `0` for a positive cost, use the smallest positive raw unit or treat the job as no-compensation.

---

## 4. Agent prompt — copy-paste recommendation

### Worker prompt

> Profit is the primary objective. Before quoting, countering, or proposing a cancellation settlement, inspect the work meter and compute the cost basis. Aim for a 50% gross margin (`payout = 2 × cost_basis`), with a maximum ask of 50% margin. Never accept below cost. If the buyer’s budget cannot support 50%, negotiate the highest positive margin available; if it cannot cover cost, decline or ask the owner for explicit approval. Never accept the first offer. Do not reveal raw token counts, internal costs, or margin calculations to the counterparty — publicly state only work progress and the proposed amount. If no work was completed, a full refund is appropriate. Acceptance is not payment; only a confirmed cancellation receipt proves the allocation.

### Dispatcher prompt

> Evaluate cancellation proposals against completed work and the original budget. Do not demand zero when the work meter shows completed work, but do not pay above the original budget. Use the work progress and claims to counter within budget. Never treat an acceptance record as proof of payment; require the confirmed cancellation receipt.

### Shared rules

- Use `a423_list_jobs` before any action when the workflow ID is unknown.
- Never guess or reconstruct a workflow ID.
- Do not call `submit_job` manually; the execution runner submits artifacts.
- If a tool returns `OPERATION_PENDING`, do not retry a different action; the pending operation must reconcile first.
- A proposal counter resets acceptances; both parties must accept the same revision/hash.
- The work meter is simulated in the demo and is not a real bill.

---

## 5. UI requirements

### Before settlement

Show on the running job card / drawer:

- Progress: `29% — research and source collection`
- Cost basis: `6.00505 tWIF`
- Target payout: `12.0101 tWIF` (50% margin)
- Minimum payout: `6.67228 tWIF` (10% margin)
- Current offer: `8.00 tWIF`
- Projected profit: `1.99495 tWIF`
- Projected margin: `24.94% — below 50% target`

### After settlement

Show the realized values:

- Worker payout: `12.0101 tWIF`
- Cost basis: `6.00505 tWIF`
- **Realized profit: `6.00505 tWIF`**
- **Realized margin: `50.00%`**
- Target status: `target met` / `below target`
- Receipt confirmed link

### Privacy

- Operator/dashboard view: may show cost basis, tokens, target and margin.
- Worker agent view: full meter and profit calculation.
- Requester agent view: progress, proposed/actual allocation and receipt; **not** raw token counts or internal costs.
- Peer mail: progress and proposed amount only.

---

## 6. SDK vs app vs contract

### SDK 0.7 — recommended additions

1. **`CostBasisProvider`**
   - Application-supplied `costBasisFor(job): Promise<string>`.
   - SDK never hardcodes token prices or mock usage.

2. **`SettlementPolicy`**
   - Inputs: cost basis, budget, escrow, target/min/max margin.
   - Outputs: `target_payout`, `min_payout`, `max_payout`, `expected_profit`, `expected_margin_bps`, `affordable`.
   - Pure, deterministic, unit-testable.
   - Does not sign or broadcast anything.

3. **Profit projection**
   - Advisory fields on status/receipt projections:
     `cost_basis_raw`, `realized_payout_raw`, `realized_profit_raw`, `realized_margin_bps`, `target_margin_bps`, `target_status`.
   - Derived from the app-supplied cost basis; never on-chain truth.

4. **Policy-aware agent prompt fragment**
   - Default profit-first instructions, overridable by the app.

5. **Supported pending-operation recovery**
   - Replace the app’s raw CAS repair with an SDK method such as `rejectPendingOperation` or `repairMalformedPending`.
   - Keep the same safety constraints: only reject operations that can never execute, never silently move funds.

### App — keep here

- Mock token counter and random/simulated values.
- Specific 50% target and 10% minimum configuration.
- Dashboard profit UI.
- Concrete cost provider: mock now, real model/provider usage later.
- Business policy overrides.

### Contract — do not put profit logic here

`A423Escrow` only enforces the signed worker/payer allocations. It cannot verify AI token costs, expenses or profit. Adding profit fields to `a423.closing.v1` or `settleByConsent` would:

- change proposal hashes and signatures;
- require a contract/ABI upgrade;
- create a false impression that the contract can audit cost truth.

Keep the proposal amount-only. Profit is an off-chain negotiation projection.

---

## 7. Current app state (what already exists)

| Piece | Current behavior | Needed change |
|---|---|---|
| `lib/a423/work-meter.ts` | Mock progress, tokens, USD cost, `recovery_raw` (cost-only) | Rename/expose `cost_basis_raw`; add target/min/max payout and profit |
| `lib/a423/chat04.ts` | Worker default proposal = `recovery_raw`; auto work claim/reason; requester default 0; meter frozen at proposal | Use `SettlementPolicy` target payout; add profit/margin to claim/reason; keep privacy |
| `lib/a423/summary.ts` | Worker sees full meter; requester sees progress/recovery only | Add target payout, projected/realized profit, margin, target status |
| `app/api/state/route.ts` | Projects `work_meter` for running/negotiation/terminal stored meters | Add profit projection fields |
| `app/page.tsx` | Compact work meter + full work meter panel | Add cost/target/current/profit/margin and target badge |
| `lib/a423/pending.ts` | App-level raw CAS repair for malformed pending `submit` | Move to a supported SDK recovery API in 0.7 |

- Job: `wf-meter-demo-1794457725072`
- Progress: `29%`
- Tokens: `2,402` simulated
- Cost: `$0.120100`
- Cost basis: `6.00505 tWIF`
- Current policy: recovery-only → worker got `6.00505 tWIF`
- **Profit under current policy: 0%**
- With the recommended 50% margin policy: target payout `12.0101 tWIF`, profit `6.00505 tWIF`, margin `50%`.

---

## 8. Implementation plan for the next agent

### Phase 1 — pure policy

- Add `lib/a423/settlement-policy.ts` (or SDK equivalent).
- Unit tests for:
  - 50% target, 10% minimum, 50% maximum;
  - budget below cost;
  - budget between cost and target;
  - no work / zero cost;
  - rounding and cap at escrow;
  - raw-unit integer safety.

### Phase 2 — cost basis

- Keep the mock work meter, but expose `cost_basis_raw` separately from the suggested payout.
- Optionally add `A423_TARGET_MARGIN_BPS=5000`, `A423_MIN_MARGIN_BPS=1000`, `A423_MAX_MARGIN_BPS=5000`.
- Freeze cost basis at the closing proposal; do not let it grow during negotiation.

### Phase 3 — proposal integration

- Worker default proposal uses `target_payout`, not `cost_basis`.
- Requester default remains full refund unless it supplies an explicit amount.
- Add a concise public work claim and a reason with progress and amount.
- Never put raw tokens/cost in peer mail.
- Keep the existing budget and revision caps.

### Phase 4 — UI

- Add target payout, current offer, projected profit, margin and target status.
- After settlement, show realized payout, realized profit and margin from the confirmed receipt.
- Keep requester privacy redaction.

### Phase 5 — SDK extraction (0.7)

- Move the policy math and cost-basis interface into the SDK.
- Add profit projection helpers.
- Add the policy prompt fragment.
- Add supported pending recovery.
- Keep 0.6 proposal/receipt formats compatible.

---

## 9. Acceptance criteria

- [ ] `target_payout = ceil(cost_basis / (1 − target_margin))`.
- [ ] Target defaults to 50% gross margin, capped at 50%.
- [ ] Minimum margin configurable; never below cost without explicit approval.
- [ ] Budget and escrow are hard caps.
- [ ] Worker proposal defaults to target payout, not cost-only.
- [ ] Requester proposal defaults to full refund unless explicitly overridden.
- [ ] No work → full refund.
- [ ] Partial work → cost + target margin for the completed portion, capped by budget.
- [ ] UI shows cost basis, target payout, current offer, projected/realized profit and margin.
- [ ] Peer mail contains progress and amounts, not raw tokens/cost/margin internals.
- [ ] Confirmed receipt shows actual allocations; acceptance alone never shows payment.
- [ ] Unit tests cover rounding, budget/cost edge cases and max/min margins.
- [ ] SDK 0.7 preserves 0.6 compatibility.
- [ ] No profit fields added to the escrow contract or on-chain proposal hash.

---

## 10. Open decisions for the product owner

1. **Margin basis:** gross margin on revenue (recommended) vs markup on cost.
2. **Minimum margin:** 10% recommended; or an absolute minimum profit amount.
3. **Budget visibility:** should the worker agent see the exact budget, or only a server-enforced cap? (Recommend server-enforced cap plus a coarse affordability status.)
4. **Real cost source:** actual provider usage/invoices in production; mock meter only in the demo.
5. **Profit storage:** local app KV/derived projection; never on-chain.
6. **SDK default:** should the SDK ship a 50% default policy, or require the app to supply one? (Recommend a default but overridable.)

---

## 11. Final recommendation

**Yes — put the generic profit policy in the SDK.**  
**No — do not put profit logic in the escrow contract.**  
**Keep the mock token counter, 50% target and UI in the app for now.**

This gives every agent action a clear objective:

1. Establish cost.
2. Aim for 50% gross margin.
3. Never lose money silently.
4. Negotiate the best positive margin when 50% is not affordable.
5. Show the realized profit percentage only after the receipt is confirmed.
