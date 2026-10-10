import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  locations,
  orderItemShortages,
  orderItems,
  orders,
  outboxEvents,
  productBarcodes,
  products,
  stockReservations,
  type DbExecutor,
  type DbHandle,
} from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import {
  FulfilmentBlockedError,
  InsufficientStockError,
  InvalidStateTransitionError,
  NotFoundError,
  ProductUnavailableError,
  ValidationError,
  WrongItemError,
} from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { LedgerService } from "../inventory/ledger.service";
import { allocateLine, lockEligibleBalances } from "./allocation";
import { type OrderStatus, transitionOrder } from "./order-state";

export const pickSchema = z.object({
  orderItemId: z.string().uuid(),
  locationId: z.string().uuid(),
  /** What the picker scanned. It must belong to the line's product. */
  barcode: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(10_000),
});
export type PickRequest = z.input<typeof pickSchema>;

export const shortPickSchema = z.object({
  orderItemId: z.string().uuid(),
  locationId: z.string().uuid(),
  /** Units the picker could not find in this bin. */
  quantity: z.number().int().positive().max(10_000),
  reason: z.string().trim().min(1).max(500),
});
export type ShortPickRequest = z.input<typeof shortPickSchema>;

const resolutionReason = z.string().trim().min(1).max(500);

/**
 * `reallocate` reserves the units again from other stock; `remove` accepts
 * the order going out short; `substitute` adds a line for another product,
 * reserved in full, in place of the missing units.
 */
export const resolveShortageSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("reallocate"), reason: resolutionReason }),
  z.object({ resolution: z.literal("remove"), reason: resolutionReason }),
  z.object({
    resolution: z.literal("substitute"),
    reason: resolutionReason,
    substituteProductId: z.string().uuid(),
    quantity: z.number().int().positive().max(10_000),
  }),
]);
export type ResolveShortageRequest = z.input<typeof resolveShortageSchema>;

export const packSchema = z.object({
  /** The packer's own count of every line. */
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(0).max(10_000) }))
    .min(1)
    .max(200),
});
export type PackRequest = z.input<typeof packSchema>;

export type PickTask = {
  locationId: string;
  locationCode: string;
  batchId: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  quantity: number;
};

export interface FulfilmentLine {
  orderItemId: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  requestedQty: number;
  reservedQty: number;
  pickedQty: number;
  fulfilledQty: number;
  openShortageQty: number;
  /** The line this one replaces, when a Store Manager substituted another product. */
  substitutesItemId: string | null;
  /** Where to pick the reserved units, earliest expiry first within each bin. */
  tasks: PickTask[];
}

export interface FulfilmentView {
  orderId: string;
  status: OrderStatus;
  lines: FulfilmentLine[];
  openShortages: {
    shortageId: string;
    orderItemId: string;
    source: string;
    quantity: number;
    /** When the shortage passed the store's escalation time; null until then. */
    escalatedAt: Date | null;
  }[];
}

export interface OpenShortage {
  shortageId: string;
  orderId: string;
  externalRef: string;
  orderStatus: OrderStatus;
  orderItemId: string;
  productId: string;
  sku: string;
  source: string;
  quantity: number;
  createdAt: Date;
  escalatedAt: Date | null;
}

type OpenAllocation = {
  id: string;
  balance_id: string;
  product_id: string;
  batch_id: string | null;
  location_id: string;
  open: number;
};

/**
 * Picking, short picks, shortage resolution, packing and handover.
 *
 * Every step locks the order row first, then any balance rows in primary-key
 * order, the same lock order as reservation and cancellation.
 *
 * - A pick moves reserved units from their bin to the order's packing
 *   location and consumes the allocation. Stock stays `available` there but
 *   the packing location is never allocatable, so nothing else can take it.
 * - A short pick releases the allocation, moves the missing units to
 *   `quarantined` in the same bin so no other order is promised them until a
 *   count settles it, and opens a shortage for the line.
 * - Packing is a hard gate: every shortage resolved, nothing left to pick,
 *   and the packer's count matching what was picked.
 * - Handover removes the packed units from stock and closes the reservation.
 */
@Injectable()
export class FulfilmentService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async startPicking(actor: Actor, orderId: string): Promise<FulfilmentView> {
    await this.step(actor, "orders.start_picking", { orderId }, async (tx) => {
      await this.lockOrder(tx, actor.storeId, orderId);
      await transitionOrder(tx, actor.storeId, orderId, "picking", { expectedFrom: ["accepted", "exception"] });
      await this.audit(tx, actor, "order.start_picking", orderId, {});
    });
    return this.view(actor.storeId, orderId);
  }

  async pick(actor: Actor, orderId: string, request: PickRequest): Promise<FulfilmentView> {
    const body = parse(pickSchema, request, "Invalid pick");
    await this.step(actor, "orders.pick", { orderId, ...body }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["picking"], "Start picking this order first");
      const item = await this.item(tx, orderId, body.orderItemId);

      const [scanned] = await tx
        .select({ productId: productBarcodes.productId })
        .from(productBarcodes)
        .where(eq(productBarcodes.barcode, body.barcode));
      if (!scanned || scanned.productId !== item.productId) {
        throw new WrongItemError("The scanned item is not the product on this line", {
          orderItemId: item.id,
          barcode: body.barcode,
        });
      }

      const allocations = await this.openAllocations(tx, item.id, body.locationId);
      const open = allocations.reduce((n, a) => n + a.open, 0);
      if (body.quantity > open) {
        throw new ValidationError(`Only ${open} of this item are reserved in this bin for the order`, {
          reservedHere: open,
        });
      }

      const packingLocationId = order.packingLocationId ?? (await this.assignPackingLocation(tx, actor.storeId, orderId));
      const plan = take(allocations, body.quantity);
      await this.lockForMoves(tx, actor.storeId, plan, packingLocationId);

      for (const { allocation, quantity } of plan) {
        await this.ledger.postIn(tx, {
          storeId: actor.storeId,
          productId: allocation.product_id,
          batchId: allocation.batch_id,
          quantity,
          movementType: "pick",
          sourceType: "order",
          sourceId: orderId,
          actorUserId: actor.actorUserId,
          from: { locationId: allocation.location_id, status: "available" },
          to: { locationId: packingLocationId, status: "available" },
          consumeReserved: quantity,
        });
        await tx.execute(sql`
          UPDATE reservation_allocations SET consumed_qty = consumed_qty + ${quantity} WHERE id = ${allocation.id}`);
      }
      await tx
        .update(orderItems)
        .set({
          pickedQty: sql`${orderItems.pickedQty} + ${body.quantity}`,
          reservedQty: sql`${orderItems.reservedQty} - ${body.quantity}`,
        })
        .where(eq(orderItems.id, item.id));
    });
    return this.view(actor.storeId, orderId);
  }

  async shortPick(actor: Actor, orderId: string, request: ShortPickRequest): Promise<FulfilmentView> {
    const body = parse(shortPickSchema, request, "Invalid short pick");
    await this.step(actor, "orders.short_pick", { orderId, ...body }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["picking"], "Start picking this order first");
      const item = await this.item(tx, orderId, body.orderItemId);

      const allocations = await this.openAllocations(tx, item.id, body.locationId);
      const open = allocations.reduce((n, a) => n + a.open, 0);
      if (body.quantity > open) {
        throw new ValidationError(`Only ${open} of this item are reserved in this bin for the order`, {
          reservedHere: open,
        });
      }

      const plan = take(allocations, body.quantity);
      await this.lockBalances(tx, plan.map((p) => p.allocation.balance_id));
      for (const { allocation, quantity } of plan) {
        await tx.execute(sql`
          UPDATE reservation_allocations SET released_qty = released_qty + ${quantity} WHERE id = ${allocation.id}`);
        await tx.execute(sql`
          UPDATE inventory_balances SET reserved = reserved - ${quantity}, updated_at = now()
          WHERE id = ${allocation.balance_id}`);
        // The book says these units are here; the picker says they are not.
        // Block them so no other order is promised them until a count decides.
        await this.ledger.postIn(tx, {
          storeId: actor.storeId,
          productId: allocation.product_id,
          batchId: allocation.batch_id,
          quantity,
          movementType: "status_change",
          sourceType: "short_pick",
          sourceId: orderId,
          actorUserId: actor.actorUserId,
          reason: body.reason,
          from: { locationId: allocation.location_id, status: "available" },
          to: { locationId: allocation.location_id, status: "quarantined" },
        });
      }
      await tx
        .update(orderItems)
        .set({ reservedQty: sql`${orderItems.reservedQty} - ${body.quantity}` })
        .where(eq(orderItems.id, item.id));
      const [shortage] = await tx
        .insert(orderItemShortages)
        .values({ orderItemId: item.id, source: "short_pick", quantity: body.quantity })
        .returning({ id: orderItemShortages.id });

      await this.audit(tx, actor, "order.short_pick", orderId, { ...body, shortageId: shortage!.id });
      await tx.insert(outboxEvents).values({
        storeId: actor.storeId,
        eventType: "order.short_picked",
        payload: { orderId, orderItemId: item.id, quantity: body.quantity, shortageId: shortage!.id },
      });
    });
    return this.view(actor.storeId, orderId);
  }

  /**
   * A Store Manager settles a shortage: reserve the units again from other
   * eligible stock, or accept that the order goes out short. Reallocating
   * on an order already in packing sends it back to picking.
   */
  async resolveShortage(
    actor: Actor,
    orderId: string,
    shortageId: string,
    request: ResolveShortageRequest,
  ): Promise<FulfilmentView> {
    const body = parse(resolveShortageSchema, request, "Invalid shortage resolution");
    await this.step(actor, "orders.resolve_shortage", { orderId, shortageId, ...body }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["accepted", "picking", "packing", "exception"], "This order can no longer change");

      const [shortage] = await tx
        .select({
          id: orderItemShortages.id,
          status: orderItemShortages.status,
          quantity: orderItemShortages.quantity,
          orderItemId: orderItemShortages.orderItemId,
          productId: orderItems.productId,
        })
        .from(orderItemShortages)
        .innerJoin(orderItems, eq(orderItems.id, orderItemShortages.orderItemId))
        .where(and(eq(orderItemShortages.id, shortageId), eq(orderItems.orderId, orderId)));
      if (!shortage) throw new NotFoundError("Shortage not found", { shortageId });
      if (shortage.status !== "open") throw new InvalidStateTransitionError("This shortage is already resolved", { shortageId });

      if (body.resolution === "reallocate") {
        const [reservation] = await tx
          .select({ id: stockReservations.id })
          .from(stockReservations)
          .where(eq(stockReservations.orderId, orderId));
        const eligible = await lockEligibleBalances(tx, actor.storeId, [shortage.productId]);
        const { remaining } = await allocateLine(
          tx,
          { reservationId: reservation!.id, orderItemId: shortage.orderItemId, productId: shortage.productId, quantity: shortage.quantity },
          eligible,
        );
        if (remaining > 0) {
          throw new InsufficientStockError("Not enough sellable stock to cover this shortage; remove it instead", {
            needed: shortage.quantity,
            available: shortage.quantity - remaining,
          });
        }
      }

      let substituteItemId: string | undefined;
      if (body.resolution === "substitute") {
        substituteItemId = await this.addSubstitute(tx, actor.storeId, orderId, shortage, body);
      }

      if (body.resolution !== "remove" && order.status === "packing") {
        await transitionOrder(tx, actor.storeId, orderId, "picking", { expectedFrom: ["packing"] });
      }

      await tx
        .update(orderItemShortages)
        .set({
          status: "resolved",
          resolution: RESOLUTIONS[body.resolution],
          resolvedBy: actor.actorUserId,
          resolvedAt: new Date(),
        })
        .where(and(eq(orderItemShortages.id, shortageId), eq(orderItemShortages.status, "open")));
      await this.audit(tx, actor, "order.resolve_shortage", orderId, {
        shortageId,
        ...body,
        shortQuantity: shortage.quantity,
        substituteItemId,
      });
      if (substituteItemId) {
        await tx.insert(outboxEvents).values({
          storeId: actor.storeId,
          eventType: "order.item_substituted",
          payload: { orderId, shortageId, orderItemId: substituteItemId },
        });
      }
    });
    return this.view(actor.storeId, orderId);
  }

  async completePicking(actor: Actor, orderId: string): Promise<FulfilmentView> {
    await this.step(actor, "orders.complete_picking", { orderId }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["picking"], "This order is not being picked");
      const [left] = await tx
        .select({ units: sql<number>`coalesce(sum(${orderItems.reservedQty}), 0)::int` })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));
      if (left!.units > 0) {
        throw new FulfilmentBlockedError(`${left!.units} reserved units still need picking or reporting short`, {
          unitsLeft: left!.units,
        });
      }
      await transitionOrder(tx, actor.storeId, orderId, "packing", { expectedFrom: ["picking"] });
      await this.audit(tx, actor, "order.complete_picking", orderId, {});
    });
    return this.view(actor.storeId, orderId);
  }

  /** The hard packing gate. Only an order that passes it can be handed over. */
  async pack(actor: Actor, orderId: string, request: PackRequest): Promise<FulfilmentView> {
    const body = parse(packSchema, request, "Invalid packing check");
    await this.step(actor, "orders.pack", { orderId, ...body }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["packing"], "Finish picking this order first");

      const [open] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(orderItemShortages)
        .innerJoin(orderItems, eq(orderItems.id, orderItemShortages.orderItemId))
        .where(and(eq(orderItems.orderId, orderId), eq(orderItemShortages.status, "open")));
      if (open!.count > 0) {
        throw new FulfilmentBlockedError("Resolve every shortage before packing", { openShortages: open!.count });
      }

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.lineNo);
      const counted = new Map<string, number>();
      for (const line of body.lines) {
        if (counted.has(line.orderItemId)) throw new ValidationError("Each line may be counted once", line);
        counted.set(line.orderItemId, line.quantity);
      }
      const unknown = [...counted.keys()].filter((id) => !items.some((i) => i.id === id));
      if (unknown.length) throw new ValidationError("Some lines are not on this order", { orderItemIds: unknown });

      const mismatches = items
        .filter((i) => i.reservedQty > 0 || (counted.get(i.id) ?? -1) !== i.pickedQty)
        .map((i) => ({ orderItemId: i.id, lineNo: i.lineNo, picked: i.pickedQty, counted: counted.get(i.id) ?? null, stillReserved: i.reservedQty }));
      if (mismatches.length) {
        throw new FulfilmentBlockedError("The packing count does not match what was picked", { mismatches });
      }
      if (items.every((i) => i.pickedQty === 0)) {
        throw new FulfilmentBlockedError("Nothing was picked for this order; cancel it instead");
      }

      for (const i of items) {
        await tx.update(orderItems).set({ fulfilledQty: i.pickedQty }).where(eq(orderItems.id, i.id));
      }
      await transitionOrder(tx, actor.storeId, orderId, "ready_for_handover", { expectedFrom: ["packing"] });
      await this.audit(tx, actor, "order.pack", orderId, { lines: body.lines });
    });
    return this.view(actor.storeId, orderId);
  }

  async handover(actor: Actor, orderId: string): Promise<FulfilmentView> {
    await this.step(actor, "orders.handover", { orderId }, async (tx) => {
      const order = await this.lockOrder(tx, actor.storeId, orderId);
      requireStatus(order.status, ["ready_for_handover"], "Pack this order first");

      const packed = await tx.execute<{ product_id: string; batch_id: string | null; quantity: number }>(sql`
        SELECT b.product_id, b.batch_id, sum(a.consumed_qty)::int AS quantity
        FROM reservation_allocations a
        JOIN stock_reservations r ON r.id = a.reservation_id
        JOIN inventory_balances b ON b.id = a.balance_id
        WHERE r.order_id = ${orderId} AND a.consumed_qty > 0
        GROUP BY b.product_id, b.batch_id`);
      const sources = await tx.execute<{ id: string }>(sql`
        SELECT b.id FROM inventory_balances b
        WHERE b.location_id = ${order.packingLocationId} AND b.status = 'available'
          AND (b.product_id, coalesce(b.batch_id, '00000000-0000-0000-0000-000000000000'::uuid)) IN (
            SELECT b2.product_id, coalesce(b2.batch_id, '00000000-0000-0000-0000-000000000000'::uuid)
            FROM reservation_allocations a
            JOIN stock_reservations r ON r.id = a.reservation_id
            JOIN inventory_balances b2 ON b2.id = a.balance_id
            WHERE r.order_id = ${orderId} AND a.consumed_qty > 0)`);
      await this.lockBalances(tx, sources.rows.map((r) => r.id));

      for (const line of packed.rows) {
        await this.ledger.postIn(tx, {
          storeId: actor.storeId,
          productId: line.product_id,
          batchId: line.batch_id,
          quantity: line.quantity,
          movementType: "handover",
          sourceType: "order",
          sourceId: orderId,
          actorUserId: actor.actorUserId,
          from: { locationId: order.packingLocationId!, status: "available" },
        });
      }
      await transitionOrder(tx, actor.storeId, orderId, "handed_over", { expectedFrom: ["ready_for_handover"] });
      await tx
        .update(stockReservations)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(stockReservations.orderId, orderId));
      await this.audit(tx, actor, "order.handover", orderId, {});
      await tx.insert(outboxEvents).values({ storeId: actor.storeId, eventType: "order.handed_over", payload: { orderId } });
    });
    return this.view(actor.storeId, orderId);
  }

  async view(storeId: string, orderId: string): Promise<FulfilmentView> {
    const { db } = this.handle;
    const [order] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)));
    if (!order) throw new NotFoundError("Order not found", { orderId });

    const lines = await db.execute<Omit<FulfilmentLine, "tasks">>(sql`
      SELECT i.id AS "orderItemId", i.line_no AS "lineNo", i.product_id AS "productId", p.sku, p.name,
             i.requested_qty AS "requestedQty", i.reserved_qty AS "reservedQty", i.picked_qty AS "pickedQty",
             i.fulfilled_qty AS "fulfilledQty",
             coalesce((SELECT sum(s.quantity) FROM order_item_shortages s
                       WHERE s.order_item_id = i.id AND s.status = 'open'), 0)::int AS "openShortageQty",
             (SELECT s.order_item_id FROM order_item_shortages s WHERE s.id = i.substitutes_shortage_id) AS "substitutesItemId"
      FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ${orderId}
      ORDER BY i.line_no`);
    const tasks = await db.execute<PickTask & { orderItemId: string }>(sql`
      SELECT a.order_item_id AS "orderItemId", b.location_id AS "locationId", l.code AS "locationCode",
             b.batch_id AS "batchId", bt.lot_code AS "lotCode", to_char(bt.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
             sum(a.quantity - a.consumed_qty - a.released_qty)::int AS quantity
      FROM reservation_allocations a
      JOIN order_items i ON i.id = a.order_item_id
      JOIN inventory_balances b ON b.id = a.balance_id
      JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE i.order_id = ${orderId} AND a.quantity - a.consumed_qty - a.released_qty > 0
      GROUP BY a.order_item_id, b.location_id, l.code, b.batch_id, bt.lot_code, bt.expiry_date
      ORDER BY l.code, bt.expiry_date NULLS LAST`);
    const shortages = await db
      .select({
        shortageId: orderItemShortages.id,
        orderItemId: orderItemShortages.orderItemId,
        source: orderItemShortages.source,
        quantity: orderItemShortages.quantity,
        escalatedAt: orderItemShortages.escalatedAt,
      })
      .from(orderItemShortages)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShortages.orderItemId))
      .where(and(eq(orderItems.orderId, orderId), eq(orderItemShortages.status, "open")))
      .orderBy(asc(orderItemShortages.createdAt));

    return {
      orderId,
      status: order.status,
      lines: lines.rows.map((l) => ({
        ...l,
        tasks: tasks.rows.filter((t) => t.orderItemId === l.orderItemId).map(({ orderItemId: _, ...t }) => t),
      })),
      openShortages: shortages,
    };
  }

  /**
   * Adds a line for the substitute product and reserves all of it, or
   * refuses. The order row is already locked; balance rows are locked next.
   */
  private async addSubstitute(
    tx: DbExecutor,
    storeId: string,
    orderId: string,
    shortage: { id: string; productId: string },
    body: { substituteProductId: string; quantity: number },
  ): Promise<string> {
    if (body.substituteProductId === shortage.productId) {
      throw new ValidationError("Pick a different product, or reallocate the shortage instead");
    }
    const [product] = await tx
      .select({ status: products.status })
      .from(products)
      .where(eq(products.id, body.substituteProductId));
    if (!product || product.status !== "active") {
      throw new ProductUnavailableError("The substitute product is unknown or inactive", {
        productIds: [body.substituteProductId],
      });
    }
    const [{ next }] = (
      await tx.execute<{ next: number }>(sql`
        SELECT coalesce(max(line_no), 0)::int + 1 AS next FROM order_items WHERE order_id = ${orderId}`)
    ).rows as [{ next: number }];
    const [item] = await tx
      .insert(orderItems)
      .values({
        orderId,
        lineNo: next,
        productId: body.substituteProductId,
        requestedQty: body.quantity,
        substitutesShortageId: shortage.id,
      })
      .returning({ id: orderItems.id });
    const [reservation] = await tx
      .select({ id: stockReservations.id })
      .from(stockReservations)
      .where(eq(stockReservations.orderId, orderId));
    const eligible = await lockEligibleBalances(tx, storeId, [body.substituteProductId]);
    const { remaining } = await allocateLine(
      tx,
      { reservationId: reservation!.id, orderItemId: item!.id, productId: body.substituteProductId, quantity: body.quantity },
      eligible,
    );
    if (remaining > 0) {
      throw new InsufficientStockError("Not enough sellable stock of the substitute", {
        needed: body.quantity,
        available: body.quantity - remaining,
      });
    }
    return item!.id;
  }

  /** The Store Manager's queue: every open shortage in the store, escalated ones first, oldest first. */
  async openShortages(storeId: string): Promise<OpenShortage[]> {
    return this.handle.db
      .select({
        shortageId: orderItemShortages.id,
        orderId: orders.id,
        externalRef: orders.externalRef,
        orderStatus: orders.status,
        orderItemId: orderItems.id,
        productId: products.id,
        sku: products.sku,
        source: orderItemShortages.source,
        quantity: orderItemShortages.quantity,
        createdAt: orderItemShortages.createdAt,
        escalatedAt: orderItemShortages.escalatedAt,
      })
      .from(orderItemShortages)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShortages.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orders.storeId, storeId), eq(orderItemShortages.status, "open")))
      .orderBy(sql`${orderItemShortages.escalatedAt} IS NULL`, asc(orderItemShortages.createdAt))
      .limit(500);
  }

  /** Runs one fulfilment step: retried on deadlock, at most once per idempotency key. */
  private async step(actor: Actor, scope: string, request: unknown, fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
    await withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope, key: actor.idempotencyKey, request }, async () => {
          await fn(tx);
          return { ok: true };
        }),
      ),
    );
  }

  private async lockOrder(tx: DbExecutor, storeId: string, orderId: string) {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status, packingLocationId: orders.packingLocationId })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
      .for("update");
    if (!order) throw new NotFoundError("Order not found", { orderId });
    return order;
  }

  private async item(tx: DbExecutor, orderId: string, orderItemId: string) {
    const [item] = await tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, orderId)));
    if (!item) throw new NotFoundError("Order line not found", { orderItemId });
    return item;
  }

  /** Open allocations of one line in one bin, earliest expiry first. */
  private async openAllocations(tx: DbExecutor, orderItemId: string, locationId: string): Promise<OpenAllocation[]> {
    const result = await tx.execute<OpenAllocation>(sql`
      SELECT a.id, a.balance_id, b.product_id, b.batch_id, b.location_id,
             (a.quantity - a.consumed_qty - a.released_qty)::int AS open
      FROM reservation_allocations a
      JOIN inventory_balances b ON b.id = a.balance_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE a.order_item_id = ${orderItemId} AND b.location_id = ${locationId}
        AND a.quantity - a.consumed_qty - a.released_qty > 0
      ORDER BY bt.expiry_date NULLS LAST, a.id`);
    return result.rows;
  }

  /** The store's packing location for this order, fixed at the first pick. */
  private async assignPackingLocation(tx: DbExecutor, storeId: string, orderId: string): Promise<string> {
    const [packing] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.storeId, storeId), eq(locations.purpose, "packing"), eq(locations.status, "active")))
      .orderBy(locations.code)
      .limit(1);
    if (!packing) throw new ValidationError("Set up a packing location before picking");
    await tx.update(orders).set({ packingLocationId: packing.id }).where(eq(orders.id, orderId));
    return packing.id;
  }

  /**
   * Creates any missing destination rows, then locks sources and
   * destinations together in primary-key order before the ledger moves
   * anything, so concurrent picks never take the same rows in another order.
   */
  private async lockForMoves(
    tx: DbExecutor,
    storeId: string,
    plan: { allocation: OpenAllocation }[],
    destinationId: string,
  ): Promise<void> {
    const ids = plan.map((p) => p.allocation.balance_id);
    for (const { allocation } of plan) {
      // DO NOTHING takes no lock on an existing row, so the lock order below holds.
      await tx.execute(sql`
        INSERT INTO inventory_balances (store_id, location_id, product_id, batch_id, status)
        VALUES (${storeId}, ${destinationId}, ${allocation.product_id}, ${allocation.batch_id}, 'available')
        ON CONFLICT ON CONSTRAINT inventory_balances_bucket DO NOTHING`);
      const [row] = (
        await tx.execute<{ id: string }>(sql`
          SELECT id FROM inventory_balances
          WHERE store_id = ${storeId} AND location_id = ${destinationId} AND product_id = ${allocation.product_id}
            AND batch_id IS NOT DISTINCT FROM ${allocation.batch_id} AND status = 'available'`)
      ).rows;
      ids.push(row!.id);
    }
    await this.lockBalances(tx, ids);
  }

  private async lockBalances(tx: DbExecutor, ids: string[]): Promise<void> {
    const unique = [...new Set(ids.map(String))];
    if (unique.length === 0) return;
    await tx.execute(sql`
      SELECT id FROM inventory_balances
      WHERE id IN (${sql.join(
        unique.map((id) => sql`${id}::bigint`),
        sql`, `,
      )})
      ORDER BY id FOR UPDATE`);
  }

  private async audit(tx: DbExecutor, actor: Actor, action: string, orderId: string, after: Record<string, unknown>) {
    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action,
      entityType: "order",
      entityId: orderId,
      after,
    });
  }
}

const RESOLUTIONS = { reallocate: "reallocated", remove: "removed", substitute: "substituted" } as const;

function requireStatus(status: OrderStatus, allowed: OrderStatus[], message: string): void {
  if (!allowed.includes(status)) throw new InvalidStateTransitionError(message, { status, allowed });
}

/** Splits a quantity across allocations in the order given. */
function take(allocations: OpenAllocation[], quantity: number): { allocation: OpenAllocation; quantity: number }[] {
  const plan: { allocation: OpenAllocation; quantity: number }[] = [];
  let left = quantity;
  for (const allocation of allocations) {
    if (left === 0) break;
    const q = Math.min(left, allocation.open);
    plan.push({ allocation, quantity: q });
    left -= q;
  }
  return plan;
}
