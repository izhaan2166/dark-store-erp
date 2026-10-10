import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  batches,
  locations,
  outboxEvents,
  products,
  stockCountLines,
  stockCounts,
  stockCountStatus,
  storeSettings,
  type DbExecutor,
  type DbHandle,
} from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { InsufficientStockError, InvalidStateTransitionError, NotFoundError, ProductUnavailableError, ValidationError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { LedgerService } from "./ledger.service";

export const submitCountSchema = z.object({
  locationId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        batchId: z.string().uuid().nullable().default(null),
        countedQty: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(500),
});
export type SubmitCountRequest = z.input<typeof submitCountSchema>;

export const countDecisionSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export interface CountThresholds {
  qtyThreshold: number;
  valueThresholdPaise: number;
}

/**
 * Whether a counted line needs a Store Manager's approval before it changes
 * stock. Releasing blocked units back to sale always does (quarantine
 * release). Otherwise the variance must stay within both the unit and the
 * value threshold; a product with no cost yet always needs approval.
 */
export function countNeedsApproval(
  line: { variance: number; releasesBlocked: number; unitCostPaise: number | null },
  thresholds: CountThresholds,
): boolean {
  if (line.releasesBlocked > 0) return true;
  if (line.variance === 0) return false;
  if (line.unitCostPaise === null) return true;
  const units = Math.abs(line.variance);
  return units > thresholds.qtyThreshold || units * line.unitCostPaise > thresholds.valueThresholdPaise;
}

/** How a line's difference is applied: removals come out of blocked units first. */
export function countPlan(line: { bookQty: number; blockedQty: number; countedQty: number }) {
  const variance = line.countedQty - line.bookQty;
  const removeBlocked = variance < 0 ? Math.min(-variance, line.blockedQty) : 0;
  const removeAvailable = variance < 0 ? -variance - removeBlocked : 0;
  return {
    variance,
    removeBlocked,
    removeAvailable,
    add: Math.max(variance, 0),
    /** Blocked units the counter found after all, which go back on sale. */
    releasesBlocked: line.blockedQty - removeBlocked,
  };
}

export const listCountsSchema = z.object({
  status: z.enum(stockCountStatus.enumValues).default("pending_approval"),
});

/** A count as a Store Manager reviews it: the shelf, who counted, and each difference with its value. */
export type CountSummary = {
  stockCountId: string;
  status: string;
  createdAt: string;
  locationCode: string;
  countedByName: string;
  lines: {
    productId: string;
    sku: string;
    name: string;
    lotCode: string | null;
    bookQty: number;
    blockedQty: number;
    countedQty: number;
    variance: number;
    varianceValuePaise: number | null;
    needsApproval: boolean;
  }[];
};

export interface CountView {
  stockCountId: string;
  locationId: string;
  status: "pending_approval" | "posted" | "rejected";
  decisionReason: string | null;
  lines: {
    productId: string;
    batchId: string | null;
    bookQty: number;
    blockedQty: number;
    countedQty: number;
    variance: number;
    varianceValuePaise: number | null;
    needsApproval: boolean;
  }[];
}

/**
 * Cycle counts of one storage location.
 *
 * The counter submits what they found per product and batch. The book
 * quantity is everything in the location that is `available` or blocked as
 * `quarantined` (a short pick blocks units this way until a count settles
 * them). Within the store's thresholds the count posts at once as
 * `adjustment` movements; otherwise, or when blocked units would go back on
 * sale, it waits for a Store Manager.
 *
 * Posting applies the variance recorded at count time. Units reserved by
 * orders are never adjusted away: if the shelf holds fewer than are
 * reserved, the count is refused and the picker reports a short pick first.
 */
@Injectable()
export class CountsService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async submitCount(actor: Actor, request: SubmitCountRequest): Promise<CountView> {
    const body = parse(submitCountSchema, request, "Invalid count");
    const keys = body.lines.map((l) => `${l.productId}:${l.batchId ?? ""}`);
    if (new Set(keys).size !== keys.length) throw new ValidationError("Count each product and batch once");

    const stockCountId = await withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope: "stock_counts.submit", key: actor.idempotencyKey, request: body }, async () => {
          const [location] = await tx
            .select({ purpose: locations.purpose, status: locations.status })
            .from(locations)
            .where(and(eq(locations.id, body.locationId), eq(locations.storeId, actor.storeId)))
            .for("share");
          if (!location) throw new NotFoundError("Location not found", { locationId: body.locationId });
          if (location.purpose !== "storage") throw new ValidationError("Counts are for storage locations");

          const productIds = [...new Set(body.lines.map((l) => l.productId))];
          const productRows = await tx
            .select({ id: products.id, cost: products.avgUnitCostPaise, batchTracked: products.batchTracked })
            .from(products)
            .where(inArray(products.id, productIds));
          const productById = new Map(productRows.map((p) => [p.id, p]));
          const missing = productIds.filter((id) => !productById.has(id));
          if (missing.length) throw new ProductUnavailableError("Some products are unknown", { productIds: missing });

          for (const line of body.lines) {
            const tracked = productById.get(line.productId)!.batchTracked;
            if (tracked !== (line.batchId !== null)) {
              throw new ValidationError(tracked ? "Count batch-tracked products per batch" : "This product has no batches", {
                productId: line.productId,
              });
            }
            if (line.batchId) {
              const [batch] = await tx
                .select({ productId: batches.productId })
                .from(batches)
                .where(eq(batches.id, line.batchId));
              if (batch?.productId !== line.productId) throw new NotFoundError("Batch not found", { batchId: line.batchId });
            }
          }

          const thresholds = await this.thresholds(tx, actor.storeId);
          const book = await this.book(tx, actor.storeId, body.locationId, productIds);
          const lines = body.lines.map((l) => {
            const held = book.get(`${l.productId}:${l.batchId ?? ""}`) ?? { available: 0, blocked: 0 };
            const bookQty = held.available + held.blocked;
            const unitCostPaise = productById.get(l.productId)!.cost;
            const plan = countPlan({ bookQty, blockedQty: held.blocked, countedQty: l.countedQty });
            return {
              productId: l.productId,
              batchId: l.batchId,
              bookQty,
              blockedQty: held.blocked,
              countedQty: l.countedQty,
              unitCostPaise,
              needsApproval: countNeedsApproval({ ...plan, unitCostPaise }, thresholds),
            };
          });
          const needsApproval = lines.some((l) => l.needsApproval);

          const [count] = await tx
            .insert(stockCounts)
            .values({
              storeId: actor.storeId,
              locationId: body.locationId,
              status: needsApproval ? "pending_approval" : "posted",
              countedBy: actor.actorUserId,
              postedAt: needsApproval ? null : new Date(),
            })
            .returning({ id: stockCounts.id });
          await tx.insert(stockCountLines).values(lines.map((l) => ({ ...l, stockCountId: count!.id })));

          if (!needsApproval) await this.postInTx(tx, actor, count!.id);
          await tx.insert(auditLogs).values({
            storeId: actor.storeId,
            actorUserId: actor.actorUserId,
            action: "stock_count.submit",
            entityType: "stock_count",
            entityId: count!.id,
            after: { ...body, status: needsApproval ? "pending_approval" : "posted" },
          });
          if (needsApproval) {
            await tx.insert(outboxEvents).values({
              storeId: actor.storeId,
              eventType: "stock_count.approval_requested",
              payload: { stockCountId: count!.id, locationId: body.locationId },
            });
          }
          return count!.id;
        }),
      ),
    );
    return this.getCount(actor.storeId, stockCountId);
  }

  async approveCount(actor: Actor, stockCountId: string, reason: string): Promise<CountView> {
    return this.decide(actor, stockCountId, reason, "posted");
  }

  async rejectCount(actor: Actor, stockCountId: string, reason: string): Promise<CountView> {
    return this.decide(actor, stockCountId, reason, "rejected");
  }

  private async decide(actor: Actor, stockCountId: string, reason: string, to: "posted" | "rejected"): Promise<CountView> {
    const { reason: trimmed } = parse(countDecisionSchema, { reason }, "A reason is required");
    await withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(
          tx,
          {
            storeId: actor.storeId,
            scope: to === "posted" ? "stock_counts.approve" : "stock_counts.reject",
            key: actor.idempotencyKey,
            request: { stockCountId, reason: trimmed },
          },
          async () => {
            const updated = await tx
              .update(stockCounts)
              .set({ status: to, decidedBy: actor.actorUserId, decisionReason: trimmed, postedAt: to === "posted" ? new Date() : null })
              .where(
                and(
                  eq(stockCounts.id, stockCountId),
                  eq(stockCounts.storeId, actor.storeId),
                  eq(stockCounts.status, "pending_approval"),
                ),
              )
              .returning({ id: stockCounts.id });
            if (updated.length === 0) {
              const [exists] = await tx
                .select({ id: stockCounts.id })
                .from(stockCounts)
                .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.storeId, actor.storeId)));
              if (!exists) throw new NotFoundError("Count not found", { stockCountId });
              throw new InvalidStateTransitionError("This count is not waiting for approval", { stockCountId });
            }
            if (to === "posted") await this.postInTx(tx, actor, stockCountId);
            await tx.insert(auditLogs).values({
              storeId: actor.storeId,
              actorUserId: actor.actorUserId,
              action: to === "posted" ? "stock_count.approve" : "stock_count.reject",
              entityType: "stock_count",
              entityId: stockCountId,
              before: { status: "pending_approval" },
              after: { status: to, reason: trimmed },
            });
            return { stockCountId };
          },
        ),
      ),
    );
    return this.getCount(actor.storeId, stockCountId);
  }

  private async postInTx(tx: DbExecutor, actor: Actor, stockCountId: string): Promise<void> {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, stockCountId));
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, stockCountId));
    const locationId = count!.locationId;

    // Lock every balance row the count may touch, in primary-key order.
    await tx.execute(sql`
      SELECT id FROM inventory_balances
      WHERE location_id = ${locationId} AND status IN ('available', 'quarantined')
        AND product_id IN ${[...new Set(lines.map((l) => l.productId))]}
      ORDER BY id FOR UPDATE`);

    const move = (
      line: (typeof lines)[number],
      quantity: number,
      movementType: "adjustment" | "status_change",
      sides: { from?: "available" | "quarantined"; to?: "available" },
    ) =>
      quantity > 0
        ? this.ledger.postIn(tx, {
            storeId: actor.storeId,
            productId: line.productId,
            batchId: line.batchId,
            quantity,
            movementType,
            sourceType: "stock_count",
            sourceId: stockCountId,
            actorUserId: actor.actorUserId,
            reason: `Stock count ${stockCountId}`,
            from: sides.from ? { locationId, status: sides.from } : undefined,
            to: sides.to ? { locationId, status: sides.to } : undefined,
          })
        : Promise.resolve();

    for (const line of lines) {
      const plan = countPlan(line);
      await move(line, plan.removeBlocked, "adjustment", { from: "quarantined" });
      await move(line, plan.removeAvailable, "adjustment", { from: "available" }).catch((err: unknown) => {
        if (!(err instanceof InsufficientStockError)) throw err;
        throw new InsufficientStockError(
          "Orders have reserved more of this item than the count found; report a short pick for them first",
          { productId: line.productId, batchId: line.batchId },
        );
      });
      await move(line, plan.releasesBlocked, "status_change", { from: "quarantined", to: "available" });
      await move(line, plan.add, "adjustment", { to: "available" });
    }
    await tx.insert(outboxEvents).values({
      storeId: actor.storeId,
      eventType: "stock_count.posted",
      payload: { stockCountId, locationId, postedBy: actor.actorUserId },
    });
  }

  /** Counts by status, oldest first; by default those waiting for a Store Manager. */
  async listCounts(storeId: string, query: unknown): Promise<CountSummary[]> {
    const { status } = parse(listCountsSchema, query, "Invalid filter");
    const result = await this.handle.db.execute<CountSummary>(sql`
      SELECT c.id AS "stockCountId", c.status, c.created_at AS "createdAt", l.code AS "locationCode",
             u.name AS "countedByName",
             json_agg(json_build_object(
               'productId', cl.product_id, 'sku', p.sku, 'name', p.name, 'lotCode', b.lot_code,
               'bookQty', cl.book_qty, 'blockedQty', cl.blocked_qty, 'countedQty', cl.counted_qty,
               'variance', cl.counted_qty - cl.book_qty,
               'varianceValuePaise', (cl.counted_qty - cl.book_qty) * cl.unit_cost_paise,
               'needsApproval', cl.needs_approval) ORDER BY p.name, b.expiry_date) AS lines
      FROM stock_counts c
      JOIN locations l ON l.id = c.location_id
      JOIN users u ON u.id = c.counted_by
      JOIN stock_count_lines cl ON cl.stock_count_id = c.id
      JOIN products p ON p.id = cl.product_id
      LEFT JOIN batches b ON b.id = cl.batch_id
      WHERE c.store_id = ${storeId} AND c.status = ${status}
      GROUP BY c.id, l.code, u.name
      ORDER BY c.created_at, c.id
      LIMIT 200`);
    return result.rows;
  }

  async getCount(storeId: string, stockCountId: string): Promise<CountView> {
    const [count] = await this.handle.db
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.storeId, storeId)));
    if (!count) throw new NotFoundError("Count not found", { stockCountId });
    const lines = await this.handle.db.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, stockCountId));
    return {
      stockCountId: count.id,
      locationId: count.locationId,
      status: count.status,
      decisionReason: count.decisionReason,
      lines: lines.map((l) => {
        const variance = l.countedQty - l.bookQty;
        return {
          productId: l.productId,
          batchId: l.batchId,
          bookQty: l.bookQty,
          blockedQty: l.blockedQty,
          countedQty: l.countedQty,
          variance,
          varianceValuePaise: l.unitCostPaise === null ? null : variance * l.unitCostPaise,
          needsApproval: l.needsApproval,
        };
      }),
    };
  }

  private async thresholds(tx: DbExecutor, storeId: string): Promise<CountThresholds> {
    const [row] = await tx
      .select({
        qtyThreshold: storeSettings.countVarianceQtyThreshold,
        valueThresholdPaise: storeSettings.countVarianceValueThresholdPaise,
      })
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeId));
    if (!row) throw new NotFoundError("Store settings not found", { storeId });
    return row;
  }

  /** Units held in the location per product and batch, split into sellable and blocked. */
  private async book(tx: DbExecutor, storeId: string, locationId: string, productIds: string[]) {
    const rows = await tx.execute<{ product_id: string; batch_id: string | null; available: number; blocked: number }>(sql`
      SELECT product_id, batch_id,
             coalesce(sum(on_hand) FILTER (WHERE status = 'available'), 0)::int AS available,
             coalesce(sum(on_hand) FILTER (WHERE status = 'quarantined'), 0)::int AS blocked
      FROM inventory_balances
      WHERE store_id = ${storeId} AND location_id = ${locationId} AND product_id IN ${productIds}
      GROUP BY product_id, batch_id`);
    return new Map(rows.rows.map((r) => [`${r.product_id}:${r.batch_id ?? ""}`, { available: r.available, blocked: r.blocked }]));
  }
}
