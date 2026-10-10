import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  goodsReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  purchaseOrderStatus,
  suppliers,
  type DbHandle,
} from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { ConflictError, NotFoundError, ProductUnavailableError, ValidationError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { pgConstraint, pgErrorCode, withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";

export const createSupplierSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
});
export type CreateSupplierRequest = z.infer<typeof createSupplierSchema>;

export type SupplierView = { supplierId: string; code: string; name: string };

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  poNumber: z.string().trim().min(1).max(100),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(1_000_000),
        unitCostPaise: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(500),
});
export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderSchema>;

export const listPurchaseOrdersSchema = z.object({
  /** Comma-separated statuses; defaults to orders still expected. */
  status: z
    .string()
    .default("open")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(purchaseOrderStatus.enumValues)).min(1)),
});

export type PurchaseOrderSummary = {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string;
  status: string;
  createdAt: string;
  lineCount: number;
  orderedUnits: number;
  outstandingUnits: number;
  /** Receipts against this order waiting for a Store Manager; their units are not counted as received yet. */
  pendingReceipts: number;
};

export interface PurchaseOrderView {
  purchaseOrderId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  pendingReceipts: number;
  lines: {
    purchaseOrderLineId: string;
    lineNo: number;
    productId: string;
    sku: string;
    name: string;
    batchTracked: boolean;
    orderedQty: number;
    receivedQty: number;
    outstandingQty: number;
    unitCostPaise: number;
  }[];
}

/** Suppliers and purchase orders: what the store expects to receive. */
@Injectable()
export class PurchasingService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async createSupplier(actor: Actor, request: CreateSupplierRequest): Promise<{ supplierId: string }> {
    const body = parse(createSupplierSchema, request, "Invalid supplier");
    try {
      return await this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope: "suppliers.create", key: actor.idempotencyKey, request: body }, async () => {
          const [row] = await tx
            .insert(suppliers)
            .values({ storeId: actor.storeId, code: body.code, name: body.name })
            .returning({ id: suppliers.id });
          await tx.insert(auditLogs).values({
            storeId: actor.storeId,
            actorUserId: actor.actorUserId,
            action: "supplier.create",
            entityType: "supplier",
            entityId: row!.id,
            after: body,
          });
          return { supplierId: row!.id };
        }),
      );
    } catch (err) {
      if (pgErrorCode(err) === "23505" && pgConstraint(err) === "suppliers_store_code") {
        throw new ConflictError("A supplier with this code already exists", { code: body.code });
      }
      throw err;
    }
  }

  /** Active suppliers, by name, for the purchase order screen. */
  async listSuppliers(storeId: string): Promise<SupplierView[]> {
    return this.handle.db
      .select({ supplierId: suppliers.id, code: suppliers.code, name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.storeId, storeId), eq(suppliers.status, "active")))
      .orderBy(asc(suppliers.name), asc(suppliers.id));
  }

  async createPurchaseOrder(actor: Actor, request: CreatePurchaseOrderRequest): Promise<PurchaseOrderView> {
    const body = parse(createPurchaseOrderSchema, request, "Invalid purchase order");
    const productIds = body.lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new ValidationError("Each product may appear on only one purchase order line");
    }
    try {
      const purchaseOrderId = await withTransactionRetry(() =>
        this.handle.db.transaction((tx) =>
          runIdempotent(tx, { storeId: actor.storeId, scope: "purchase_orders.create", key: actor.idempotencyKey, request: body }, async () => {
            const [supplier] = await tx
              .select({ status: suppliers.status })
              .from(suppliers)
              .where(and(eq(suppliers.id, body.supplierId), eq(suppliers.storeId, actor.storeId)));
            if (!supplier) throw new NotFoundError("Supplier not found", { supplierId: body.supplierId });
            if (supplier.status !== "active") throw new ValidationError("Supplier is inactive");

            const found = await tx
              .select({ id: products.id, status: products.status })
              .from(products)
              .where(inArray(products.id, productIds));
            const active = new Set(found.filter((p) => p.status === "active").map((p) => p.id));
            const unavailable = productIds.filter((id) => !active.has(id));
            if (unavailable.length) throw new ProductUnavailableError("Some products are unknown or inactive", { productIds: unavailable });

            const [po] = await tx
              .insert(purchaseOrders)
              .values({ storeId: actor.storeId, supplierId: body.supplierId, poNumber: body.poNumber, createdBy: actor.actorUserId })
              .returning({ id: purchaseOrders.id });
            await tx.insert(purchaseOrderLines).values(
              body.lines.map((l, i) => ({
                purchaseOrderId: po!.id,
                lineNo: i + 1,
                productId: l.productId,
                orderedQty: l.quantity,
                unitCostPaise: l.unitCostPaise,
              })),
            );
            await tx.insert(auditLogs).values({
              storeId: actor.storeId,
              actorUserId: actor.actorUserId,
              action: "purchase_order.create",
              entityType: "purchase_order",
              entityId: po!.id,
              after: body,
            });
            return po!.id;
          }),
        ),
      );
      return this.getPurchaseOrder(actor.storeId, purchaseOrderId);
    } catch (err) {
      if (pgErrorCode(err) === "23505" && pgConstraint(err) === "purchase_orders_store_number") {
        throw new ConflictError("A purchase order with this number already exists", { poNumber: body.poNumber });
      }
      throw err;
    }
  }

  /** Purchase orders for the receiving screen, oldest first. */
  async listPurchaseOrders(storeId: string, query: unknown): Promise<PurchaseOrderSummary[]> {
    const { status } = parse(listPurchaseOrdersSchema, query, "Invalid filter");
    const result = await this.handle.db.execute<PurchaseOrderSummary>(sql`
      SELECT po.id AS "purchaseOrderId", po.po_number AS "poNumber", s.name AS "supplierName", po.status,
             po.created_at AS "createdAt",
             count(l.id)::int AS "lineCount",
             coalesce(sum(l.ordered_qty), 0)::int AS "orderedUnits",
             coalesce(sum(greatest(l.ordered_qty - l.received_qty, 0)), 0)::int AS "outstandingUnits",
             (SELECT count(*)::int FROM goods_receipts g
              WHERE g.purchase_order_id = po.id AND g.status = 'pending_approval') AS "pendingReceipts"
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN purchase_order_lines l ON l.purchase_order_id = po.id
      WHERE po.store_id = ${storeId}
        AND po.status IN (${sql.join(
          status.map((st) => sql`${st}`),
          sql`, `,
        )})
      GROUP BY po.id, s.name
      ORDER BY po.created_at, po.id
      LIMIT 200`);
    return result.rows;
  }

  async getPurchaseOrder(storeId: string, purchaseOrderId: string): Promise<PurchaseOrderView> {
    const { db } = this.handle;
    const [po] = await db
      .select({
        id: purchaseOrders.id,
        poNumber: purchaseOrders.poNumber,
        supplierId: purchaseOrders.supplierId,
        supplierName: suppliers.name,
        status: purchaseOrders.status,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(and(eq(purchaseOrders.id, purchaseOrderId), eq(purchaseOrders.storeId, storeId)));
    if (!po) throw new NotFoundError("Purchase order not found", { purchaseOrderId });
    const lines = await db
      .select({
        id: purchaseOrderLines.id,
        lineNo: purchaseOrderLines.lineNo,
        productId: purchaseOrderLines.productId,
        sku: products.sku,
        name: products.name,
        batchTracked: products.batchTracked,
        orderedQty: purchaseOrderLines.orderedQty,
        receivedQty: purchaseOrderLines.receivedQty,
        unitCostPaise: purchaseOrderLines.unitCostPaise,
      })
      .from(purchaseOrderLines)
      .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
      .orderBy(purchaseOrderLines.lineNo);
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.purchaseOrderId, po.id), eq(goodsReceipts.status, "pending_approval")));
    return {
      purchaseOrderId: po.id,
      poNumber: po.poNumber,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      status: po.status,
      pendingReceipts: pending!.count,
      lines: lines.map((l) => ({
        purchaseOrderLineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        sku: l.sku,
        name: l.name,
        batchTracked: l.batchTracked,
        orderedQty: l.orderedQty,
        receivedQty: l.receivedQty,
        outstandingQty: Math.max(0, l.orderedQty - l.receivedQty),
        unitCostPaise: l.unitCostPaise,
      })),
    };
  }
}
