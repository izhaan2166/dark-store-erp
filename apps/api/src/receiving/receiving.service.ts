import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  batches,
  goodsReceiptLines,
  goodsReceipts,
  locations,
  outboxEvents,
  products,
  purchaseOrderLines,
  purchaseOrders,
  receivingDiscrepancies,
  storeSettings,
  suppliers,
  type DbExecutor,
  type DbHandle,
} from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import {
  InvalidStateTransitionError,
  NotFoundError,
  ProductUnavailableError,
  ValidationError,
} from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { LedgerService } from "../inventory/ledger.service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const recordReceiptSchema = z
  .object({
    /** Omit for an ad hoc receipt; then supplierId is required and every line needs approval. */
    purchaseOrderId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    receivingLocationId: z.string().uuid(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          lotCode: z.string().trim().min(1).max(100).optional(),
          expiryDate: isoDate.optional(),
          acceptedQty: z.number().int().min(0).max(1_000_000),
          damagedQty: z.number().int().min(0).max(1_000_000).default(0),
          rejectedQty: z.number().int().min(0).max(1_000_000).default(0),
          /** Defaults to the purchase order line's cost. Required for unordered items. */
          unitCostPaise: z.number().int().min(0).max(100_000_000).optional(),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine((r) => r.purchaseOrderId || r.supplierId, { message: "Give a purchase order or, for an ad hoc receipt, a supplier" });
export type RecordReceiptRequest = z.input<typeof recordReceiptSchema>;
type ReceiptBody = z.output<typeof recordReceiptSchema>;

export const decisionSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const putawaySchema = z.object({
  productId: z.string().uuid(),
  batchId: z.string().uuid().nullable().default(null),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  quantity: z.number().int().positive().max(1_000_000),
});
export type PutawayRequest = z.input<typeof putawaySchema>;

export interface ReceiptView {
  goodsReceiptId: string;
  status: "pending_approval" | "posted" | "cancelled";
  purchaseOrderId: string | null;
  supplierId: string;
  receivingLocationId: string;
  decisionReason: string | null;
  lines: {
    goodsReceiptLineId: string;
    lineNo: number;
    productId: string;
    batchId: string | null;
    expectedQty: number;
    acceptedQty: number;
    damagedQty: number;
    rejectedQty: number;
    unitCostPaise: number;
    needsApproval: boolean;
  }[];
  discrepancies: { goodsReceiptLineId: string; kind: string; quantity: number }[];
}

/**
 * Whether accepted units differ from what was expected by more than the
 * store's tolerance. Expected 0 (unordered, ad hoc, or already fully
 * received) means any accepted quantity needs approval.
 */
export function receivingNeedsApproval(expected: number, accepted: number, tolerancePct: number): boolean {
  if (expected === 0) return accepted > 0;
  return Math.abs(accepted - expected) * 100 > tolerancePct * expected;
}

/**
 * Goods receipts (GRNs) and putaway.
 *
 * A receipt within tolerance posts at once: accepted units land in the
 * receiving location with status `receiving`, damaged units in quarantine
 * with status `damaged`, rejected units never enter stock. A receipt outside
 * tolerance waits in `pending_approval` and moves no stock until a Store
 * Manager approves it with a reason. Putaway then moves units from
 * receiving into a storage bin as `available`, which is when they become
 * sellable.
 *
 * Lock order: purchase order row, then goods receipt row, then product rows
 * by id, then balance rows by id (inside the ledger).
 */
@Injectable()
export class ReceivingService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async recordReceipt(actor: Actor, request: RecordReceiptRequest): Promise<ReceiptView> {
    const body = parse(recordReceiptSchema, request, "Invalid goods receipt");
    const goodsReceiptId = await withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(
          tx,
          { storeId: actor.storeId, scope: "goods_receipts.record", key: actor.idempotencyKey, request: body },
          () => this.recordInTx(tx, actor, body),
        ),
      ),
    );
    return this.getReceipt(actor.storeId, goodsReceiptId);
  }

  private async recordInTx(tx: DbExecutor, actor: Actor, body: ReceiptBody): Promise<string> {
    const settings = await this.storeSettings(tx, actor.storeId);

    // The purchase order row is locked first, so two receipts against the
    // same order see each other's quantities rather than racing.
    let supplierId = body.supplierId;
    const poLines = new Map<string, typeof purchaseOrderLines.$inferSelect>();
    if (body.purchaseOrderId) {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, body.purchaseOrderId), eq(purchaseOrders.storeId, actor.storeId)))
        .for("update");
      if (!po) throw new NotFoundError("Purchase order not found", { purchaseOrderId: body.purchaseOrderId });
      if (po.status === "cancelled") throw new ValidationError("This purchase order is cancelled");
      if (supplierId && supplierId !== po.supplierId) {
        throw new ValidationError("The supplier does not match the purchase order");
      }
      supplierId = po.supplierId;
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
      for (const line of lines) poLines.set(line.productId, line);
    } else {
      const [supplier] = await tx
        .select({ status: suppliers.status })
        .from(suppliers)
        .where(and(eq(suppliers.id, supplierId!), eq(suppliers.storeId, actor.storeId)));
      if (!supplier) throw new NotFoundError("Supplier not found", { supplierId });
      if (supplier.status !== "active") throw new ValidationError("Supplier is inactive");
    }

    await this.requireLocation(tx, actor.storeId, body.receivingLocationId, "receiving");

    const productIds = [...new Set(body.lines.map((l) => l.productId))];
    const productRows = await tx.select().from(products).where(inArray(products.id, productIds));
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const unavailable = productIds.filter((id) => productById.get(id)?.status !== "active");
    if (unavailable.length) {
      throw new ProductUnavailableError("Some products are unknown or inactive", { productIds: unavailable });
    }

    // Variance is judged per purchase order line, so lines for the same
    // product (several lots in one delivery) are added up first.
    const acceptedByProduct = new Map<string, number>();
    for (const line of body.lines) {
      acceptedByProduct.set(line.productId, (acceptedByProduct.get(line.productId) ?? 0) + line.acceptedQty);
    }
    const expectedByProduct = new Map<string, number>();
    const needsByProduct = new Map<string, boolean>();
    for (const [productId, accepted] of acceptedByProduct) {
      const poLine = poLines.get(productId);
      const expected = poLine ? Math.max(0, poLine.orderedQty - poLine.receivedQty) : 0;
      expectedByProduct.set(productId, expected);
      needsByProduct.set(productId, receivingNeedsApproval(expected, accepted, settings.receivingVariancePct));
    }
    const needsApproval = [...needsByProduct.values()].some(Boolean);

    const [grn] = await tx
      .insert(goodsReceipts)
      .values({
        storeId: actor.storeId,
        purchaseOrderId: body.purchaseOrderId ?? null,
        supplierId: supplierId!,
        receivingLocationId: body.receivingLocationId,
        status: needsApproval ? "pending_approval" : "posted",
        receivedBy: actor.actorUserId,
        postedAt: needsApproval ? null : new Date(),
      })
      .returning({ id: goodsReceipts.id });
    const goodsReceiptId = grn!.id;

    const firstLineOfProduct = new Map<string, string>();
    for (const [index, line] of body.lines.entries()) {
      const product = productById.get(line.productId)!;
      const poLine = poLines.get(line.productId);
      const batchId = await this.resolveBatch(tx, product, line, settings.today);
      if (line.acceptedQty + line.damagedQty + line.rejectedQty === 0) {
        throw new ValidationError("Each receipt line needs at least one unit", { lineNo: index + 1 });
      }
      const unitCostPaise = line.unitCostPaise ?? poLine?.unitCostPaise;
      if (unitCostPaise === undefined) {
        throw new ValidationError("A unit cost is required for items not on the purchase order", {
          productId: line.productId,
        });
      }

      const [inserted] = await tx
        .insert(goodsReceiptLines)
        .values({
          goodsReceiptId,
          lineNo: index + 1,
          purchaseOrderLineId: poLine?.id ?? null,
          productId: line.productId,
          batchId,
          expectedQty: expectedByProduct.get(line.productId)!,
          acceptedQty: line.acceptedQty,
          damagedQty: line.damagedQty,
          rejectedQty: line.rejectedQty,
          unitCostPaise,
          needsApproval: needsByProduct.get(line.productId)!,
        })
        .returning({ id: goodsReceiptLines.id });
      const lineId = inserted!.id;
      if (!firstLineOfProduct.has(line.productId)) firstLineOfProduct.set(line.productId, lineId);

      // Damaged and rejected units are never accepted and always recorded.
      const perLine = [
        { kind: "damaged" as const, quantity: line.damagedQty },
        { kind: "rejected" as const, quantity: line.rejectedQty },
      ].filter((d) => d.quantity > 0);
      if (perLine.length) {
        await tx
          .insert(receivingDiscrepancies)
          .values(perLine.map((d) => ({ goodsReceiptLineId: lineId, ...d, note: line.note ?? null })));
      }
    }

    // Quantity differences against the purchase order, one per product.
    for (const [productId, accepted] of acceptedByProduct) {
      const expected = expectedByProduct.get(productId)!;
      const kind = !poLines.has(productId) ? "unordered" : accepted < expected ? "short" : accepted > expected ? "excess" : null;
      const quantity = kind === "unordered" ? accepted : Math.abs(accepted - expected);
      if (kind && quantity > 0) {
        await tx
          .insert(receivingDiscrepancies)
          .values({ goodsReceiptLineId: firstLineOfProduct.get(productId)!, kind, quantity });
      }
    }

    if (!needsApproval) await this.postInTx(tx, actor, goodsReceiptId);

    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action: "goods_receipt.record",
      entityType: "goods_receipt",
      entityId: goodsReceiptId,
      after: { ...body, status: needsApproval ? "pending_approval" : "posted" },
    });
    await tx.insert(outboxEvents).values({
      storeId: actor.storeId,
      eventType: needsApproval ? "goods_receipt.approval_requested" : "goods_receipt.posted",
      payload: { goodsReceiptId, purchaseOrderId: body.purchaseOrderId ?? null },
    });
    return goodsReceiptId;
  }

  /** Store Manager approves a receipt outside tolerance; its stock is posted now. */
  async approveReceipt(actor: Actor, goodsReceiptId: string, reason: string): Promise<ReceiptView> {
    return this.decide(actor, goodsReceiptId, reason, "posted");
  }

  /** Store Manager refuses a receipt outside tolerance; no stock moves. */
  async cancelReceipt(actor: Actor, goodsReceiptId: string, reason: string): Promise<ReceiptView> {
    return this.decide(actor, goodsReceiptId, reason, "cancelled");
  }

  private async decide(
    actor: Actor,
    goodsReceiptId: string,
    reason: string,
    to: "posted" | "cancelled",
  ): Promise<ReceiptView> {
    const { reason: trimmed } = parse(decisionSchema, { reason }, "A reason is required");
    await withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(
          tx,
          {
            storeId: actor.storeId,
            scope: to === "posted" ? "goods_receipts.approve" : "goods_receipts.cancel",
            key: actor.idempotencyKey,
            request: { goodsReceiptId, reason: trimmed },
          },
          async () => {
            const [grn] = await tx
              .select({ purchaseOrderId: goodsReceipts.purchaseOrderId })
              .from(goodsReceipts)
              .where(and(eq(goodsReceipts.id, goodsReceiptId), eq(goodsReceipts.storeId, actor.storeId)));
            if (!grn) throw new NotFoundError("Goods receipt not found", { goodsReceiptId });
            if (grn.purchaseOrderId) {
              await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, grn.purchaseOrderId)).for("update");
            }

            // Compare-and-set: only a receipt still waiting can be decided.
            const updated = await tx
              .update(goodsReceipts)
              .set({
                status: to,
                decidedBy: actor.actorUserId,
                decisionReason: trimmed,
                postedAt: to === "posted" ? new Date() : null,
              })
              .where(and(eq(goodsReceipts.id, goodsReceiptId), eq(goodsReceipts.status, "pending_approval")))
              .returning({ id: goodsReceipts.id });
            if (updated.length === 0) {
              throw new InvalidStateTransitionError("This receipt is not waiting for approval", { goodsReceiptId, to });
            }

            if (to === "posted") await this.postInTx(tx, actor, goodsReceiptId);
            await tx.insert(auditLogs).values({
              storeId: actor.storeId,
              actorUserId: actor.actorUserId,
              action: to === "posted" ? "goods_receipt.approve" : "goods_receipt.cancel",
              entityType: "goods_receipt",
              entityId: goodsReceiptId,
              before: { status: "pending_approval" },
              after: { status: to, reason: trimmed },
            });
            await tx.insert(outboxEvents).values({
              storeId: actor.storeId,
              eventType: to === "posted" ? "goods_receipt.posted" : "goods_receipt.cancelled",
              payload: { goodsReceiptId, purchaseOrderId: grn.purchaseOrderId },
            });
            return { goodsReceiptId };
          },
        ),
      ),
    );
    return this.getReceipt(actor.storeId, goodsReceiptId);
  }

  /** Moves the receipt's stock, updates the purchase order and product costs. */
  private async postInTx(tx: DbExecutor, actor: Actor, goodsReceiptId: string): Promise<void> {
    const [grn] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, goodsReceiptId));
    const lines = await tx
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId))
      .orderBy(asc(goodsReceiptLines.productId), asc(goodsReceiptLines.lineNo));
    const productIds = [...new Set(lines.map((l) => l.productId))].sort();
    await tx.execute(sql`SELECT id FROM products WHERE id IN ${productIds} ORDER BY id FOR UPDATE`);

    let quarantineId: string | undefined;
    if (lines.some((l) => l.damagedQty > 0)) {
      const [quarantine] = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(eq(locations.storeId, actor.storeId), eq(locations.purpose, "quarantine"), eq(locations.status, "active")),
        )
        .orderBy(locations.code)
        .limit(1);
      if (!quarantine) throw new ValidationError("Set up a quarantine location before receiving damaged units");
      quarantineId = quarantine.id;
    }

    const move = (line: (typeof lines)[number], quantity: number, locationId: string, status: "receiving" | "damaged") =>
      this.ledger.postIn(tx, {
        storeId: actor.storeId,
        productId: line.productId,
        batchId: line.batchId,
        quantity,
        movementType: "receipt",
        sourceType: "goods_receipt",
        sourceId: goodsReceiptId,
        actorUserId: actor.actorUserId,
        to: { locationId, status },
      });
    for (const line of lines) {
      if (line.acceptedQty > 0) await move(line, line.acceptedQty, grn!.receivingLocationId, "receiving");
      if (line.damagedQty > 0) await move(line, line.damagedQty, quarantineId!, "damaged");
    }

    // Moving weighted-average cost over everything now on hand.
    for (const productId of productIds) {
      const accepted = lines.filter((l) => l.productId === productId && l.acceptedQty > 0);
      const qty = accepted.reduce((n, l) => n + l.acceptedQty, 0);
      if (qty === 0) continue;
      const value = accepted.reduce((n, l) => n + l.acceptedQty * l.unitCostPaise, 0);
      await tx.execute(sql`
        WITH on_hand AS (
          SELECT coalesce(sum(on_hand), 0)::bigint AS total FROM inventory_balances WHERE product_id = ${productId}
        )
        UPDATE products p
        SET avg_unit_cost_paise = CASE
          WHEN p.avg_unit_cost_paise IS NULL OR on_hand.total <= ${qty} THEN round(${value}::numeric / ${qty})
          ELSE round((p.avg_unit_cost_paise::numeric * (on_hand.total - ${qty}) + ${value}) / on_hand.total)
        END
        FROM on_hand
        WHERE p.id = ${productId}`);
    }

    if (grn!.purchaseOrderId) {
      for (const productId of productIds) {
        const lineId = lines.find((l) => l.productId === productId)?.purchaseOrderLineId;
        const qty = lines.filter((l) => l.productId === productId).reduce((n, l) => n + l.acceptedQty, 0);
        if (lineId && qty > 0) {
          await tx
            .update(purchaseOrderLines)
            .set({ receivedQty: sql`${purchaseOrderLines.receivedQty} + ${qty}` })
            .where(eq(purchaseOrderLines.id, lineId));
        }
      }
      await tx.execute(sql`
        UPDATE purchase_orders po SET status = 'received', updated_at = now()
        WHERE po.id = ${grn!.purchaseOrderId} AND po.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                          WHERE l.purchase_order_id = po.id AND l.received_qty < l.ordered_qty)`);
    }
  }

  /** Moves received units into a storage bin, where they become sellable. */
  async putaway(actor: Actor, request: PutawayRequest): Promise<{ putawayId: string; movementId: number }> {
    const body = parse(putawaySchema, request, "Invalid putaway");
    return withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope: "inventory.putaway", key: actor.idempotencyKey, request: body }, async () => {
          await this.requireLocation(tx, actor.storeId, body.fromLocationId, "receiving");
          await this.requireLocation(tx, actor.storeId, body.toLocationId, "storage");
          if (body.batchId) {
            const settings = await this.storeSettings(tx, actor.storeId);
            const [batch] = await tx
              .select({ expiryDate: batches.expiryDate, productId: batches.productId })
              .from(batches)
              .where(eq(batches.id, body.batchId));
            if (!batch || batch.productId !== body.productId) throw new NotFoundError("Batch not found", { batchId: body.batchId });
            if (batch.expiryDate && batch.expiryDate <= settings.today) {
              throw new ValidationError("Expired stock cannot be put away for sale; move it to quarantine");
            }
          }
          const putawayId = randomUUID();
          const posted = await this.ledger.postIn(tx, {
            storeId: actor.storeId,
            productId: body.productId,
            batchId: body.batchId,
            quantity: body.quantity,
            movementType: "putaway",
            sourceType: "putaway",
            sourceId: putawayId,
            actorUserId: actor.actorUserId,
            from: { locationId: body.fromLocationId, status: "receiving" },
            to: { locationId: body.toLocationId, status: "available" },
          });
          return { putawayId, movementId: posted.movementId };
        }),
      ),
    );
  }

  async getReceipt(storeId: string, goodsReceiptId: string): Promise<ReceiptView> {
    const { db } = this.handle;
    const [grn] = await db
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, goodsReceiptId), eq(goodsReceipts.storeId, storeId)));
    if (!grn) throw new NotFoundError("Goods receipt not found", { goodsReceiptId });
    const lines = await db
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grn.id))
      .orderBy(goodsReceiptLines.lineNo);
    const discrepancies = lines.length
      ? await db
          .select({
            goodsReceiptLineId: receivingDiscrepancies.goodsReceiptLineId,
            kind: receivingDiscrepancies.kind,
            quantity: receivingDiscrepancies.quantity,
          })
          .from(receivingDiscrepancies)
          .where(inArray(receivingDiscrepancies.goodsReceiptLineId, lines.map((l) => l.id)))
      : [];
    return {
      goodsReceiptId: grn.id,
      status: grn.status,
      purchaseOrderId: grn.purchaseOrderId,
      supplierId: grn.supplierId,
      receivingLocationId: grn.receivingLocationId,
      decisionReason: grn.decisionReason,
      lines: lines.map((l) => ({
        goodsReceiptLineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        batchId: l.batchId,
        expectedQty: l.expectedQty,
        acceptedQty: l.acceptedQty,
        damagedQty: l.damagedQty,
        rejectedQty: l.rejectedQty,
        unitCostPaise: l.unitCostPaise,
        needsApproval: l.needsApproval,
      })),
      discrepancies,
    };
  }

  private async storeSettings(tx: DbExecutor, storeId: string) {
    const [row] = await tx
      .select({
        receivingVariancePct: storeSettings.receivingVariancePct,
        today: sql<string>`to_char((now() AT TIME ZONE ${storeSettings.timezone})::date, 'YYYY-MM-DD')`,
      })
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeId));
    if (!row) throw new NotFoundError("Store settings not found", { storeId });
    return row;
  }

  private async requireLocation(
    tx: DbExecutor,
    storeId: string,
    locationId: string,
    purpose: "receiving" | "storage",
  ): Promise<void> {
    const [location] = await tx
      .select({ purpose: locations.purpose, status: locations.status })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.storeId, storeId)))
      // Shared lock: a concurrent deactivation waits until this stock movement commits.
      .for("share");
    if (!location) throw new NotFoundError("Location not found", { locationId });
    if (location.status !== "active" || location.purpose !== purpose) {
      throw new ValidationError(`Location must be an active ${purpose} location`, { locationId });
    }
  }

  /** Finds or creates the batch for a batch-tracked line. */
  private async resolveBatch(
    tx: DbExecutor,
    product: typeof products.$inferSelect,
    line: ReceiptBody["lines"][number],
    today: string,
  ): Promise<string | null> {
    if (!product.batchTracked) {
      if (line.lotCode || line.expiryDate) {
        throw new ValidationError("This product is not batch tracked; leave out lot and expiry", { productId: product.id });
      }
      return null;
    }
    if (!line.lotCode || !line.expiryDate) {
      throw new ValidationError("Lot code and expiry date are required for batch-tracked products", {
        productId: product.id,
      });
    }
    if (line.expiryDate <= today && line.acceptedQty + line.damagedQty > 0) {
      throw new ValidationError("Expired goods cannot be accepted; record them as rejected", {
        productId: product.id,
        expiryDate: line.expiryDate,
      });
    }
    await tx
      .insert(batches)
      .values({ productId: product.id, lotCode: line.lotCode, expiryDate: line.expiryDate })
      .onConflictDoNothing();
    const [batch] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.productId, product.id), eq(batches.lotCode, line.lotCode)));
    if (batch!.expiryDate !== line.expiryDate) {
      throw new ValidationError("This lot is already recorded with a different expiry date", {
        lotCode: line.lotCode,
        recordedExpiry: batch!.expiryDate,
      });
    }
    return batch!.id;
  }
}
