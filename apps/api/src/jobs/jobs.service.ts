import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { auditLogs, outboxEvents, SYSTEM_USER_ID, type DbExecutor, type DbHandle } from "@dse/db";
import { withTransactionRetry } from "../common/retry";
import { DB_HANDLE } from "../database/database.tokens";
import { LedgerService } from "../inventory/ledger.service";

/** How many orders or balance rows one pass handles; the next pass picks up the rest. */
const BATCH = 200;

export interface JobRun {
  escalatedShortages: number;
  expiredReleasedUnits: number;
  expiredUnits: number;
}

/**
 * Background jobs run by the worker process. Every job is safe to run twice
 * or from two workers at once: each change is a compare-and-set or works
 * under the same locks as the API, in the same order (order row first, then
 * balance rows by id).
 */
@Injectable()
export class JobsService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** `storeId` limits a run to one store; the worker runs every store. */
  async runOnce(storeId?: string): Promise<JobRun> {
    const escalatedShortages = await this.escalateShortages(storeId);
    const { releasedUnits, expiredUnits } = await this.sweepExpired(storeId);
    return { escalatedShortages, expiredReleasedUnits: releasedUnits, expiredUnits };
  }

  /**
   * Flags shortages still open after the store's escalation time so the Store
   * Manager sees them first. The order itself is left alone: escalation never
   * cancels.
   */
  async escalateShortages(storeId?: string): Promise<number> {
    const due = await this.handle.db.execute<{ order_id: string; store_id: string }>(sql`
      SELECT DISTINCT i.order_id, o.store_id
      FROM order_item_shortages s
      JOIN order_items i ON i.id = s.order_item_id
      JOIN orders o ON o.id = i.order_id
      JOIN store_settings ss ON ss.store_id = o.store_id
      WHERE s.status = 'open' AND s.escalated_at IS NULL
        AND s.created_at <= now() - make_interval(mins => ss.shortage_escalation_minutes)
        ${storeId ? sql`AND o.store_id = ${storeId}` : sql``}
      LIMIT ${BATCH}`);

    let escalated = 0;
    for (const { order_id: orderId, store_id: orderStoreId } of due.rows) {
      escalated += await withTransactionRetry(() =>
        this.handle.db.transaction(async (tx) => {
          await this.lockOrder(tx, orderId);
          // Conditional on what the query above saw: a shortage resolved or
          // escalated in the meantime is skipped.
          const rows = (
            await tx.execute<{ id: string; order_item_id: string; quantity: number }>(sql`
              UPDATE order_item_shortages s SET escalated_at = now()
              FROM order_items i, store_settings ss
              WHERE s.order_item_id = i.id AND i.order_id = ${orderId} AND ss.store_id = ${orderStoreId}
                AND s.status = 'open' AND s.escalated_at IS NULL
                AND s.created_at <= now() - make_interval(mins => ss.shortage_escalation_minutes)
              RETURNING s.id, s.order_item_id, s.quantity`)
          ).rows;
          if (rows.length === 0) return 0;
          const shortageIds = rows.map((r) => r.id);
          await this.audit(tx, orderStoreId, "order.shortage_escalate", orderId, { shortageIds });
          await tx.insert(outboxEvents).values({
            storeId: orderStoreId,
            eventType: "order.shortage_escalated",
            payload: { orderId, shortageIds },
          });
          return rows.length;
        }),
      );
    }
    return escalated;
  }

  /**
   * Takes expired batches off sale. Units reserved by orders are released
   * first and become `expired` shortages on those orders; then every free
   * unit moves from `available` to `expired` in the same location. Units
   * already picked into a packing location are left to the packer.
   */
  async sweepExpired(storeId?: string): Promise<{ releasedUnits: number; expiredUnits: number }> {
    const inStore = storeId ? sql`AND b.store_id = ${storeId}` : sql``;
    const affected = await this.handle.db.execute<{ order_id: string; store_id: string }>(sql`
      SELECT DISTINCT r.order_id, b.store_id
      FROM reservation_allocations a
      JOIN stock_reservations r ON r.id = a.reservation_id
      JOIN inventory_balances b ON b.id = a.balance_id
      WHERE a.quantity - a.consumed_qty - a.released_qty > 0
        AND ${expiredBalance(sql`b`)} ${inStore}
      LIMIT ${BATCH}`);
    let releasedUnits = 0;
    for (const { order_id: orderId, store_id: orderStoreId } of affected.rows) {
      releasedUnits += await withTransactionRetry(() =>
        this.handle.db.transaction((tx) => this.releaseExpired(tx, orderStoreId, orderId)),
      );
    }

    const rows = await this.handle.db.execute<{ id: string }>(sql`
      SELECT b.id FROM inventory_balances b
      WHERE b.on_hand > b.reserved AND ${expiredBalance(sql`b`)} ${inStore}
      ORDER BY b.id
      LIMIT ${BATCH}`);
    let expiredUnits = 0;
    for (const { id } of rows.rows) {
      expiredUnits += await withTransactionRetry(() => this.handle.db.transaction((tx) => this.expireBalance(tx, id)));
    }
    return { releasedUnits, expiredUnits };
  }

  private async releaseExpired(tx: DbExecutor, storeId: string, orderId: string): Promise<number> {
    await this.lockOrder(tx, orderId);
    const open = (
      await tx.execute<{ id: string; balance_id: string; order_item_id: string; open_qty: number }>(sql`
        SELECT a.id, a.balance_id, a.order_item_id, (a.quantity - a.consumed_qty - a.released_qty)::int AS open_qty
        FROM reservation_allocations a
        JOIN stock_reservations r ON r.id = a.reservation_id
        JOIN inventory_balances b ON b.id = a.balance_id
        WHERE r.order_id = ${orderId}
          AND a.quantity - a.consumed_qty - a.released_qty > 0
          AND ${expiredBalance(sql`b`)}
        ORDER BY a.balance_id`)
    ).rows;
    if (open.length === 0) return 0;

    await this.lockBalances(tx, open.map((r) => r.balance_id));
    const perItem = new Map<string, number>();
    for (const row of open) {
      await tx.execute(sql`
        UPDATE reservation_allocations SET released_qty = released_qty + ${row.open_qty} WHERE id = ${row.id}`);
      await tx.execute(sql`
        UPDATE inventory_balances SET reserved = reserved - ${row.open_qty}, updated_at = now()
        WHERE id = ${row.balance_id}`);
      perItem.set(row.order_item_id, (perItem.get(row.order_item_id) ?? 0) + row.open_qty);
    }
    const shortageIds: string[] = [];
    for (const [orderItemId, quantity] of perItem) {
      await tx.execute(sql`
        UPDATE order_items SET reserved_qty = reserved_qty - ${quantity} WHERE id = ${orderItemId}`);
      const [shortage] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO order_item_shortages (order_item_id, source, quantity)
          VALUES (${orderItemId}, 'expired', ${quantity}) RETURNING id`)
      ).rows;
      shortageIds.push(shortage!.id);
    }
    const released = open.reduce((n, r) => n + r.open_qty, 0);
    await this.audit(tx, storeId, "order.release_expired", orderId, { shortageIds, quantity: released });
    await tx.insert(outboxEvents).values({
      storeId,
      eventType: "order.stock_expired",
      payload: { orderId, shortageIds, quantity: released },
    });
    return released;
  }

  private async expireBalance(tx: DbExecutor, balanceId: string): Promise<number> {
    const [source] = (
      await tx.execute<{ store_id: string; location_id: string; product_id: string; batch_id: string; expiry_date: string }>(sql`
        SELECT b.store_id, b.location_id, b.product_id, b.batch_id, to_char(bt.expiry_date, 'YYYY-MM-DD') AS expiry_date
        FROM inventory_balances b JOIN batches bt ON bt.id = b.batch_id
        WHERE b.id = ${balanceId}`)
    ).rows;
    if (!source) return 0;
    // Create the destination first and lock both rows in id order, then read
    // the free quantity under the lock. DO NOTHING takes no lock on an
    // existing row, so the lock order holds.
    await tx.execute(sql`
      INSERT INTO inventory_balances (store_id, location_id, product_id, batch_id, status)
      VALUES (${source.store_id}, ${source.location_id}, ${source.product_id}, ${source.batch_id}, 'expired')
      ON CONFLICT ON CONSTRAINT inventory_balances_bucket DO NOTHING`);
    const [destination] = (
      await tx.execute<{ id: string }>(sql`
        SELECT id FROM inventory_balances
        WHERE store_id = ${source.store_id} AND location_id = ${source.location_id} AND product_id = ${source.product_id}
          AND batch_id = ${source.batch_id} AND status = 'expired'`)
    ).rows;
    await this.lockBalances(tx, [balanceId, destination!.id]);
    const [row] = (
      await tx.execute<{ free: number }>(sql`
        SELECT (b.on_hand - b.reserved)::int AS free FROM inventory_balances b
        WHERE b.id = ${balanceId} AND ${expiredBalance(sql`b`)}`)
    ).rows;
    if (!row || row.free <= 0) return 0;

    await this.ledger.postIn(tx, {
      storeId: source.store_id,
      productId: source.product_id,
      batchId: source.batch_id,
      quantity: row.free,
      movementType: "status_change",
      sourceType: "expiry_sweep",
      sourceId: `${source.batch_id}:${source.expiry_date}`,
      actorUserId: SYSTEM_USER_ID,
      reason: `Batch expired on ${source.expiry_date}`,
      from: { locationId: source.location_id, status: "available" },
      to: { locationId: source.location_id, status: "expired" },
    });
    return row.free;
  }

  private async lockOrder(tx: DbExecutor, orderId: string): Promise<void> {
    await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
  }

  private async lockBalances(tx: DbExecutor, ids: string[]): Promise<void> {
    const unique = [...new Set(ids.map(String))];
    await tx.execute(sql`
      SELECT id FROM inventory_balances
      WHERE id IN (${sql.join(
        unique.map((id) => sql`${id}::bigint`),
        sql`, `,
      )})
      ORDER BY id FOR UPDATE`);
  }

  private async audit(tx: DbExecutor, storeId: string, action: string, orderId: string, after: Record<string, unknown>) {
    await tx.insert(auditLogs).values({ storeId, actorUserId: SYSTEM_USER_ID, action, entityType: "order", entityId: orderId, after });
  }
}

/**
 * An `available` balance whose batch has expired in the store's own time
 * zone, outside packing locations. `alias` names the inventory_balances row.
 */
function expiredBalance(alias: ReturnType<typeof sql>) {
  return sql`${alias}.status = 'available'
    AND EXISTS (
      SELECT 1 FROM batches bt
      JOIN store_settings ss ON ss.store_id = ${alias}.store_id
      JOIN locations l ON l.id = ${alias}.location_id
      WHERE bt.id = ${alias}.batch_id AND l.purpose <> 'packing'
        AND bt.expiry_date <= (now() AT TIME ZONE ss.timezone)::date)`;
}
