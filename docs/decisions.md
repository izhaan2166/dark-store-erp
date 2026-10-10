# Decisions

Frozen on 10 Oct 2026. Change them only when implementation or testing shows a real problem, and record the change here.

## Scope and stack

- One operator, one dark store for the pilot. Every operational table carries `store_id`; no multi-customer tenancy.
- Modular monolith: React + Vite PWA, NestJS API, PostgreSQL 16, Drizzle ORM with SQL migrations. The API and the background worker are separate processes from one codebase. No framework or ORM changes mid-build.
- Orders are entered manually or as test orders in the MVP; CSV import later. No commerce integration until access is authorised.
- Scanning: keyboard-wedge USB/Bluetooth scanners from day one; camera scanning only if phones or tablets are used in the pilot. **Open:** which real devices the pilot uses, to be tested in Week 1.
- One developer working with Claude; 8 weeks is a target, and phase gates outrank the calendar.

## Sign-in and permissions

- Email and password sign-in. Passwords are hashed with scrypt; the API returns an opaque bearer token and stores only its SHA-256 hash. Sessions last 12 hours and can be revoked.
- Roles (Super Admin, Store Manager, Inventory Manager, Receiving Staff, Picker, Packer, Auditor) are granted per store, and one person may hold several. Each role maps to permissions in code; the backend checks them on every request and reads roles fresh each time, so removing a role takes effect immediately.
- Every route is private unless marked public. A route under `/stores/:storeId` must declare a permission or it is refused. A user with no role in a store gets `404`, the same as a store that does not exist.

## Inventory model

- `inventory_movements` is the authoritative, append-only record of physical stock changes. A trigger blocks UPDATE and DELETE; corrections are reversal movements.
- `inventory_balances` holds the current balance per store, location, product, batch and **stock status** (`receiving`, `available`, `quarantined`, `damaged`, `expired`), updated in the same transaction as each movement.
- `reserved` on a balance row deliberately duplicates the open quantity of its reservation allocations. Both change in the same transaction, and reconciliation checks they agree.
- Available to promise = sum of `on_hand - reserved` over `available` rows in allocatable storage locations whose batch is beyond the sell-by cutoff. Blocked stock is never in an `available` row, so nothing is subtracted twice.
- Reservations never change `on_hand`. Physical movements happen only at named warehouse events (GRN, putaway, transfer, pick, handover, return to stock, status change, approved adjustment or write-off).

## Reservation

- Exact batches and bins are allocated at reservation time, earliest expiry first (FEFO).
- All eligible balance rows for the order's products are locked with `SELECT … FOR UPDATE` in primary-key order. Lock order and FEFO order are separate. The order row, when it exists, is always locked before balance rows.
- Partial reservation: whatever is eligible is reserved; each uncovered quantity becomes an `order_item_shortages` row. Pickers start on available items while a manager resolves shortages; nothing reaches `ready_for_handover` until every shortage is resolved.
- Deadlocks (`40P01`) and serialization failures (`40001`) retry the whole transaction with jittered backoff. `SKIP LOCKED` and `NOWAIT` are not used.
- Every write takes an idempotency key, stored with a hash of the request. Same key and payload returns the stored result; same key with a different payload is rejected with `409 idempotency_key_reused`.

## Shortages and timeouts

- A shortage still open after `store_settings.shortage_escalation_minutes` (default 15) escalates the order to the Store Manager. It does not cancel.
- Automatic cancellation is off (`auto_cancel_enabled = false`). When enabled later, the order waits in `cancel_pending` until the order source confirms; failures go to `exception` and release nothing.
- Timeout jobs act through compare-and-set transitions that name the state they observed (see [state-machines.md](state-machines.md)).

## Receiving

- A goods receipt (GRN) is recorded in one request with every line's accepted, damaged and rejected quantities. Within tolerance it posts at once; outside tolerance it waits in `pending_approval` and moves no stock until a Store Manager approves or cancels it with a reason.
- "Expected" for a line is what is still outstanding on the purchase order line when the receipt is recorded. Several lots of one product in one delivery are added up before the check.
- Accepted units land in the receiving location with status `receiving`, which is never allocatable. Putaway into a storage bin as `available` is what makes them sellable. Expired batches are refused at receiving and at putaway.
- Damaged units are recorded as received into the store's quarantine location with status `damaged`, so they are tracked but never sold. Rejected units never enter stock. Both always create a discrepancy record.
- Lock order for receiving: purchase order row, then goods receipt row, then product rows by id, then balance rows by id.

## Approval thresholds

Editable defaults in `store_settings`:

| Rule | Approval needed when | Definition |
| --- | --- | --- |
| Write-off | Always | Store Manager approves; reason and audit record required |
| Quarantine release | Always | Store Manager approves; reason and audit record required |
| Count variance | \|counted − book\| > 2 units, or \|counted − book\| × unit cost > ₹1,000, per SKU per count | Unit cost is the SKU's moving weighted-average cost (`products.avg_unit_cost_paise`) when the count is submitted, updated on every accepted GRN line. A SKU with no cost yet always needs approval |
| Receiving discrepancy | \|accepted − expected\| > 5% of expected, per PO line | Expected 0 (unordered item or ad hoc receipt): any accepted quantity needs approval. Damaged and rejected units are never accepted; they always create a discrepancy record and count toward the variance through the lower accepted quantity. Excess uses the same rule |

Money is stored in paise as integers.

## Performance targets (provisional)

| Profile | Orders/hour | Active SKUs | Concurrent staff | Duration |
| --- | --- | --- | --- | --- |
| Normal peak | 120 | 5,000 | 20 | Sustained |
| Stress | 240 | 5,000 | 30 | ≥ 15 minutes |

Pass rule: at normal peak, p95 load time of each interactive screen ≤ 2 s; zero server errors; reconciliation finds zero differences after the run settles. Demand is skewed toward popular SKUs. Recalibrate from pilot traffic.
