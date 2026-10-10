import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  orderItemShortages,
  orderItems,
  orders,
  outboxEvents,
  products,
  reservationAllocations,
  stockReservations,
  storeSettings,
  stores,
  type DbExecutor,
  type DbHandle,
} from "@dse/db";
import { z } from "zod";
import {
  DuplicateOrderError,
  InvalidStateTransitionError,
  NotFoundError,
  ProductUnavailableError,
  ValidationError,
} from "../common/errors";
import type { Actor } from "../common/actor";
import { runIdempotent } from "../common/idempotency";
import { pgConstraint, pgErrorCode, withTransactionRetry } from "../common/retry";
import { DB_HANDLE } from "../database/database.tokens";
import { transitionOrder } from "./order-state";

export const acceptOrderSchema = z.object({
  externalRef: z.string().min(1).max(100),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(10_000),
      }),
    )
    .min(1)
    .max(200),
});
export type AcceptOrderRequest = z.infer<typeof acceptOrderSchema>;

export interface AllocationView {
  balanceId: number;
  locationId: string;
  batchId: string | null;
  expiryDate: string | null;
  quantity: number;
}

export interface OrderLineView {
  orderItemId: string;
  lineNo: number;
  productId: string;
  requestedQty: number;
  reservedQty: number;
  /** Quantity that could not be reserved; an open shortage exists for it. */
  shortQty: number;
  allocations: AllocationView[];
}

export interface AcceptOrderResult {
  orderId: string;
  status: string;
  fullyReserved: boolean;
  lines: OrderLineView[];
}

export interface CancelOrderResult {
  orderId: string;
  status: "cancelled";
  releasedQty: number;
}

export interface OrderView {
  orderId: string;
  externalRef: string;
  status: string;
  createdAt: string;
  lines: {
    orderItemId: string;
    lineNo: number;
    productId: string;
    requestedQty: number;
    reservedQty: number;
    pickedQty: number;
    fulfilledQty: number;
    openShortageQty: number;
  }[];
}

export type { Actor } from "../common/actor";

type EligibleRow = {
  id: string;
  product_id: string;
  batch_id: string | null;
  location_id: string;
  on_hand: number;
  reserved: number;
  expiry_date: string | null;
};

@Injectable()
export class OrdersService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  /**
   * Accepts an order and reserves what stock exists, in one transaction.
   *
   * 1. Claim the idempotency key.
   * 2. Lock every eligible balance row for every product on the order, in
   *    primary-key order (one global lock order prevents most deadlocks).
   * 3. Allocate earliest-expiry-first (FEFO) using on_hand - reserved.
   * 4. Record allocations and raise `reserved`; open a shortage for any
   *    quantity that could not be covered (partial reservation).
   * 5. Write the outbox event and audit record, then commit.
   *
   * Deadlocks and serialization failures retry the whole transaction.
   */
  async acceptOrder(actor: Actor, request: AcceptOrderRequest): Promise<AcceptOrderResult> {
    const parsed = acceptOrderSchema.safeParse(request);
    if (!parsed.success) {
      throw new ValidationError("Invalid order", { issues: parsed.error.issues });
    }
    const body = parsed.data;
    const productIds = body.lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new ValidationError("Each product may appear on only one order line");
    }

    try {
      return await withTransactionRetry(() =>
        this.handle.db.transaction((tx) =>
          runIdempotent(
            tx,
            { storeId: actor.storeId, scope: "orders.accept", key: actor.idempotencyKey, request: body },
            () => this.acceptInTx(tx, actor, body),
          ),
        ),
      );
    } catch (err) {
      if (pgErrorCode(err) === "23505" && pgConstraint(err) === "orders_store_external_ref") {
        throw new DuplicateOrderError("An order with this external reference already exists", {
          externalRef: body.externalRef,
        });
      }
      throw err;
    }
  }

  private async acceptInTx(tx: DbExecutor, actor: Actor, body: AcceptOrderRequest): Promise<AcceptOrderResult> {
    const [store] = await tx
      .select({ status: stores.status, timezone: storeSettings.timezone, cutoff: storeSettings.sellByCutoffDays })
      .from(stores)
      .innerJoin(storeSettings, eq(storeSettings.storeId, stores.id))
      .where(eq(stores.id, actor.storeId));
    if (!store || store.status !== "active") throw new NotFoundError("Store not found or inactive");

    const productIds = body.lines.map((l) => l.productId);
    const found = await tx
      .select({ id: products.id, status: products.status })
      .from(products)
      .where(inArray(products.id, productIds));
    const unavailable = productIds.filter((id) => found.find((p) => p.id === id)?.status !== "active");
    if (unavailable.length > 0) {
      throw new ProductUnavailableError("Some products are unknown or inactive", { productIds: unavailable });
    }

    const [order] = await tx
      .insert(orders)
      .values({ storeId: actor.storeId, externalRef: body.externalRef, createdBy: actor.actorUserId })
      .returning({ id: orders.id, status: orders.status });

    const items = await tx
      .insert(orderItems)
      .values(
        body.lines.map((l, i) => ({
          orderId: order!.id,
          lineNo: i + 1,
          productId: l.productId,
          requestedQty: l.quantity,
        })),
      )
      .returning({ id: orderItems.id, lineNo: orderItems.lineNo, productId: orderItems.productId });

    // Lock order is the primary key, not expiry: every transaction that touches
    // these rows takes them in the same order. FEFO is applied afterwards.
    const eligible = await tx.execute<EligibleRow>(sql`
      SELECT b.id, b.product_id, b.batch_id, b.location_id, b.on_hand, b.reserved,
             to_char(bt.expiry_date, 'YYYY-MM-DD') AS expiry_date
      FROM inventory_balances b
      JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE b.store_id = ${actor.storeId}
        AND b.product_id IN (${sql.join(
          productIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND b.status = 'available'
        AND l.allocatable
        AND l.status = 'active'
        AND (bt.expiry_date IS NULL
             OR bt.expiry_date > (now() AT TIME ZONE ${store.timezone})::date + ${store.cutoff}::int)
      ORDER BY b.id
      FOR UPDATE OF b`);

    const [reservation] = await tx
      .insert(stockReservations)
      .values({ orderId: order!.id })
      .returning({ id: stockReservations.id });

    const lines: OrderLineView[] = [];
    for (const line of body.lines) {
      const item = items.find((it) => it.productId === line.productId)!;
      const candidates = eligible.rows
        .filter((r) => r.product_id === line.productId && r.on_hand - r.reserved > 0)
        .sort(fefo);

      let remaining = line.quantity;
      const allocations: AllocationView[] = [];
      for (const row of candidates) {
        if (remaining === 0) break;
        const take = Math.min(remaining, row.on_hand - row.reserved);
        row.reserved += take;
        remaining -= take;
        allocations.push({
          balanceId: Number(row.id),
          locationId: row.location_id,
          batchId: row.batch_id,
          expiryDate: row.expiry_date,
          quantity: take,
        });
      }

      const reservedQty = line.quantity - remaining;
      if (allocations.length > 0) {
        await tx.insert(reservationAllocations).values(
          allocations.map((a) => ({
            reservationId: reservation!.id,
            orderItemId: item.id,
            balanceId: a.balanceId,
            quantity: a.quantity,
          })),
        );
        for (const a of allocations) {
          await tx.execute(sql`
            UPDATE inventory_balances
            SET reserved = reserved + ${a.quantity}, updated_at = now()
            WHERE id = ${a.balanceId}`);
        }
        await tx.update(orderItems).set({ reservedQty }).where(eq(orderItems.id, item.id));
      }
      if (remaining > 0) {
        await tx.insert(orderItemShortages).values({ orderItemId: item.id, source: "reservation", quantity: remaining });
      }

      lines.push({
        orderItemId: item.id,
        lineNo: item.lineNo,
        productId: line.productId,
        requestedQty: line.quantity,
        reservedQty,
        shortQty: remaining,
        allocations,
      });
    }

    const result: AcceptOrderResult = {
      orderId: order!.id,
      status: order!.status,
      fullyReserved: lines.every((l) => l.shortQty === 0),
      lines,
    };

    await tx.insert(outboxEvents).values({
      storeId: actor.storeId,
      eventType: "order.accepted",
      payload: {
        orderId: result.orderId,
        externalRef: body.externalRef,
        fullyReserved: result.fullyReserved,
        shortLines: lines.filter((l) => l.shortQty > 0).map((l) => ({ lineNo: l.lineNo, shortQty: l.shortQty })),
      },
    });
    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action: "order.accept",
      entityType: "order",
      entityId: result.orderId,
      after: result as unknown as Record<string, unknown>,
    });

    return result;
  }

  /** Current state of one order in the store, with each line's quantities. */
  async getOrder(storeId: string, orderId: string): Promise<OrderView> {
    const { db } = this.handle;
    const [order] = await db
      .select({ id: orders.id, externalRef: orders.externalRef, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)));
    if (!order) throw new NotFoundError("Order not found", { orderId });

    const lines = await db
      .select({
        orderItemId: orderItems.id,
        lineNo: orderItems.lineNo,
        productId: orderItems.productId,
        requestedQty: orderItems.requestedQty,
        reservedQty: orderItems.reservedQty,
        pickedQty: orderItems.pickedQty,
        fulfilledQty: orderItems.fulfilledQty,
        openShortageQty: sql<number>`coalesce((
          SELECT sum(s.quantity) FROM order_item_shortages s
          WHERE s.order_item_id = ${orderItems.id} AND s.status = 'open'), 0)::int`,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.lineNo);

    return { orderId: order.id, externalRef: order.externalRef, status: order.status, createdAt: order.createdAt.toISOString(), lines };
  }

  /**
   * Cancels an order that has nothing picked yet and releases every open
   * allocation. Picked units need a return-to-stock movement, which arrives
   * with the picking workflow; until then such orders are refused here.
   */
  async cancelOrder(actor: Actor, orderId: string, reason: string): Promise<CancelOrderResult> {
    if (!reason || reason.trim().length === 0) throw new ValidationError("A cancellation reason is required");
    return withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(
          tx,
          { storeId: actor.storeId, scope: "orders.cancel", key: actor.idempotencyKey, request: { orderId, reason } },
          () => this.cancelInTx(tx, actor, orderId, reason),
        ),
      ),
    );
  }

  private async cancelInTx(tx: DbExecutor, actor: Actor, orderId: string, reason: string): Promise<CancelOrderResult> {
    // Global lock order: the order row first, then balance rows by id.
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.storeId, actor.storeId)))
      .for("update");
    if (!order) throw new NotFoundError("Order not found", { orderId });

    const [picked] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${orderItems.pickedQty}), 0)::int` })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    if ((picked?.total ?? 0) > 0) {
      throw new InvalidStateTransitionError("Picked units must be returned to stock before cancelling", {
        orderId,
        pickedQty: picked?.total,
      });
    }

    const transition = await transitionOrder(tx, actor.storeId, orderId, "cancelled");

    const open = await tx.execute<{ id: string; balance_id: string; open_qty: number }>(sql`
      SELECT a.id, a.balance_id, (a.quantity - a.consumed_qty - a.released_qty) AS open_qty
      FROM reservation_allocations a
      JOIN stock_reservations r ON r.id = a.reservation_id
      WHERE r.order_id = ${orderId}
        AND a.quantity - a.consumed_qty - a.released_qty > 0
      ORDER BY a.balance_id`);

    const balanceIds = [...new Set(open.rows.map((r) => r.balance_id))];
    if (balanceIds.length > 0) {
      await tx.execute(sql`
        SELECT id FROM inventory_balances
        WHERE id IN (${sql.join(
          balanceIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY id
        FOR UPDATE`);
    }

    let releasedQty = 0;
    for (const row of open.rows) {
      await tx.execute(sql`
        UPDATE inventory_balances SET reserved = reserved - ${row.open_qty}, updated_at = now()
        WHERE id = ${row.balance_id}`);
      await tx.execute(sql`
        UPDATE reservation_allocations SET released_qty = released_qty + ${row.open_qty}
        WHERE id = ${row.id}`);
      releasedQty += row.open_qty;
    }

    await tx.update(orderItems).set({ reservedQty: 0 }).where(eq(orderItems.orderId, orderId));
    await tx
      .update(stockReservations)
      .set({ status: "closed", closedAt: sql`now()` })
      .where(eq(stockReservations.orderId, orderId));
    await tx.execute(sql`
      UPDATE order_item_shortages s
      SET status = 'resolved', resolution = 'order_cancelled', resolved_by = ${actor.actorUserId}, resolved_at = now()
      FROM order_items i
      WHERE s.order_item_id = i.id AND i.order_id = ${orderId} AND s.status = 'open'`);

    await tx.insert(outboxEvents).values({
      storeId: actor.storeId,
      eventType: "order.cancelled",
      payload: { orderId, reason, releasedQty },
    });
    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action: "order.cancel",
      entityType: "order",
      entityId: orderId,
      before: { status: transition.from },
      after: { status: transition.to, reason, releasedQty },
    });

    return { orderId, status: "cancelled", releasedQty };
  }
}

/** Earliest expiry first; undated stock last; then by row id for a stable order. */
function fefo(a: EligibleRow, b: EligibleRow): number {
  if (a.expiry_date !== b.expiry_date) {
    if (a.expiry_date === null) return 1;
    if (b.expiry_date === null) return -1;
    return a.expiry_date < b.expiry_date ? -1 : 1;
  }
  return Number(a.id) - Number(b.id);
}
