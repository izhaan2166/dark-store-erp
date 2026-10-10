# State machines

Every status change is a conditional `UPDATE … WHERE status IN (allowed sources)`. If no row changes, the transition is rejected with `409 invalid_state_transition`. Callers acting on an earlier observation (timeout jobs) also pass `expectedFrom`, so a decision based on stale state fails instead of overriding newer work.

## Orders

Implemented in `apps/api/src/orders/order-state.ts`.

| From | Allowed to |
| --- | --- |
| `accepted` | `picking`, `cancel_pending`, `cancelled`, `exception` |
| `picking` | `packing`, `cancel_pending`, `cancelled`, `exception` |
| `packing` | `ready_for_handover`, `picking`, `cancel_pending`, `cancelled`, `exception` |
| `ready_for_handover` | `handed_over`, `cancel_pending`, `cancelled`, `exception` |
| `cancel_pending` | `cancelled`, `exception` |
| `exception` | `picking`, `packing`, `cancel_pending`, `cancelled` |
| `handed_over` | none (terminal) |
| `cancelled` | none (terminal) |

Rules on top of the table:

- `accepted → picking` happens when a picker starts the order. Picks and short picks are only accepted while the order is `picking`.
- `picking → packing` requires every reserved unit to be picked or reported short (`reserved_qty = 0` on every line). Open shortages may remain.
- `packing → ready_for_handover` is the hard packing gate: every shortage resolved, nothing left reserved, at least one unit picked, and the packer's count of every line equal to what was picked. `fulfilled_qty` is set to the picked quantity here.
- `packing → picking` happens when a manager reallocates a shortage after picking finished.
- `ready_for_handover → handed_over` removes the packed units from stock and closes the reservation.
- Cancelling an order with picked units requires return-to-stock movements first; until that workflow exists, such cancels are refused.
- Cancelling releases every open allocation and resolves open shortages as `order_cancelled`.

## Reservations and allocations

- A reservation is `active` until the order is cancelled or handed over, then `closed`.
- An allocation's open quantity is `quantity − consumed_qty − released_qty`. Picking consumes; cancellation, short picks and expiry release. Neither ever goes back.

## Shortages

- `open → resolved` only, with resolution, approver and time recorded (enforced by a check constraint).
- Sources: `reservation` (not enough sellable stock when the order was accepted) and `short_pick` (the picker could not find reserved units).
- Resolutions: `reallocated` (the units were reserved again from other eligible stock; refused if there is not enough), `removed` (the order goes out short; requested quantity is kept for history), `order_cancelled`.

## Purchase orders

| From | Allowed to |
| --- | --- |
| `open` | `received` (automatically, once every line's accepted quantity reaches what was ordered), `cancelled` |
| `received` | none |
| `cancelled` | none |

A receipt can still be recorded against a `received` order; with nothing outstanding, any accepted units need approval.

## Goods receipts

Implemented in `apps/api/src/receiving/receiving.service.ts`.

| From | Allowed to |
| --- | --- |
| (new, within tolerance) | `posted` |
| (new, outside tolerance) | `pending_approval` |
| `pending_approval` | `posted` (Store Manager approves with a reason), `cancelled` (Store Manager refuses with a reason) |
| `posted` | none; corrections are reversal movements |
| `cancelled` | none |

Stock moves only on entry to `posted`.

## Stock counts

Implemented in `apps/api/src/inventory/counts.service.ts`.

| From | Allowed to |
| --- | --- |
| (new, within thresholds) | `posted` |
| (new, outside thresholds or releasing blocked units) | `pending_approval` |
| `pending_approval` | `posted` (Store Manager approves with a reason), `rejected` (Store Manager rejects with a reason) |
| `posted`, `rejected` | none |
