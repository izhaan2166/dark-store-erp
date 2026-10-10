import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbExecutor, DbHandle } from "@dse/db";
import { DB_HANDLE } from "../database/database.tokens";

export interface OnHandMismatch {
  balanceId: number | null;
  locationId: string;
  productId: string;
  batchId: string | null;
  status: string;
  ledgerQty: number;
  balanceQty: number;
}

export interface ReservedMismatch {
  balanceId: number;
  reserved: number;
  openAllocations: number;
}

export interface OrderItemMismatch {
  orderItemId: string;
  reservedQty: number;
  openAllocations: number;
  pickedQty: number;
  consumedAllocations: number;
}

export interface ReconciliationReport {
  storeId: string;
  ok: boolean;
  onHand: OnHandMismatch[];
  reserved: ReservedMismatch[];
  orderItems: OrderItemMismatch[];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Checks the three duplicated representations against each other:
 * balances vs. the movement ledger, `reserved` vs. open allocations, and
 * order-line `reserved_qty` vs. open allocations, and order-line `picked_qty`
 * vs. consumed allocations. Expected result: no rows.
 */
@Injectable()
export class ReconciliationService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async run(storeId: string, executor: DbExecutor = this.handle.db): Promise<ReconciliationReport> {
    const onHand = await executor.execute<Record<string, unknown>>(sql`
      WITH flows AS (
        SELECT to_location_id AS location_id, product_id, batch_id, to_status AS status, quantity AS qty
        FROM inventory_movements
        WHERE store_id = ${storeId} AND to_location_id IS NOT NULL
        UNION ALL
        SELECT from_location_id, product_id, batch_id, from_status, -quantity
        FROM inventory_movements
        WHERE store_id = ${storeId} AND from_location_id IS NOT NULL
      ),
      ledger AS (
        SELECT location_id, product_id, batch_id, status, SUM(qty)::int AS qty
        FROM flows
        GROUP BY location_id, product_id, batch_id, status
      ),
      balances AS (
        SELECT id, location_id, product_id, batch_id, status, on_hand
        FROM inventory_balances
        WHERE store_id = ${storeId}
      )
      SELECT b.id AS balance_id,
             COALESCE(l.location_id, b.location_id) AS location_id,
             COALESCE(l.product_id, b.product_id) AS product_id,
             COALESCE(l.batch_id, b.batch_id) AS batch_id,
             COALESCE(l.status, b.status)::text AS status,
             COALESCE(l.qty, 0) AS ledger_qty,
             COALESCE(b.on_hand, 0) AS balance_qty
      FROM ledger l
      FULL OUTER JOIN balances b
        ON b.location_id = l.location_id
       AND b.product_id = l.product_id
       AND COALESCE(b.batch_id, ${NIL_UUID}::uuid) = COALESCE(l.batch_id, ${NIL_UUID}::uuid)
       AND b.status = l.status
      WHERE COALESCE(l.qty, 0) <> COALESCE(b.on_hand, 0)`);

    const reserved = await executor.execute<Record<string, unknown>>(sql`
      SELECT b.id AS balance_id,
             b.reserved,
             COALESCE(SUM(a.quantity - a.consumed_qty - a.released_qty), 0)::int AS open_allocations
      FROM inventory_balances b
      LEFT JOIN reservation_allocations a ON a.balance_id = b.id
      WHERE b.store_id = ${storeId}
      GROUP BY b.id
      HAVING b.reserved <> COALESCE(SUM(a.quantity - a.consumed_qty - a.released_qty), 0)`);

    const orderItems = await executor.execute<Record<string, unknown>>(sql`
      SELECT i.id AS order_item_id,
             i.reserved_qty,
             COALESCE(SUM(a.quantity - a.consumed_qty - a.released_qty), 0)::int AS open_allocations,
             i.picked_qty,
             COALESCE(SUM(a.consumed_qty), 0)::int AS consumed_allocations
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN reservation_allocations a ON a.order_item_id = i.id
      WHERE o.store_id = ${storeId}
      GROUP BY i.id
      HAVING i.reserved_qty <> COALESCE(SUM(a.quantity - a.consumed_qty - a.released_qty), 0)
          OR i.picked_qty <> COALESCE(SUM(a.consumed_qty), 0)`);

    const report: ReconciliationReport = {
      storeId,
      ok: false,
      onHand: onHand.rows.map((r) => ({
        balanceId: r.balance_id == null ? null : Number(r.balance_id),
        locationId: String(r.location_id),
        productId: String(r.product_id),
        batchId: r.batch_id == null ? null : String(r.batch_id),
        status: String(r.status),
        ledgerQty: Number(r.ledger_qty),
        balanceQty: Number(r.balance_qty),
      })),
      reserved: reserved.rows.map((r) => ({
        balanceId: Number(r.balance_id),
        reserved: Number(r.reserved),
        openAllocations: Number(r.open_allocations),
      })),
      orderItems: orderItems.rows.map((r) => ({
        orderItemId: String(r.order_item_id),
        reservedQty: Number(r.reserved_qty),
        openAllocations: Number(r.open_allocations),
        pickedQty: Number(r.picked_qty),
        consumedAllocations: Number(r.consumed_allocations),
      })),
    };
    report.ok = report.onHand.length === 0 && report.reserved.length === 0 && report.orderItems.length === 0;
    return report;
  }
}
