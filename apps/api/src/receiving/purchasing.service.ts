import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, products, purchaseOrderLines, purchaseOrders, suppliers, type DbHandle } from "@dse/db";
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

export interface PurchaseOrderView {
  purchaseOrderId: string;
  poNumber: string;
  supplierId: string;
  status: string;
  lines: {
    purchaseOrderLineId: string;
    lineNo: number;
    productId: string;
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

  async getPurchaseOrder(storeId: string, purchaseOrderId: string): Promise<PurchaseOrderView> {
    const { db } = this.handle;
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, purchaseOrderId), eq(purchaseOrders.storeId, storeId)));
    if (!po) throw new NotFoundError("Purchase order not found", { purchaseOrderId });
    const lines = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
      .orderBy(purchaseOrderLines.lineNo);
    return {
      purchaseOrderId: po.id,
      poNumber: po.poNumber,
      supplierId: po.supplierId,
      status: po.status,
      lines: lines.map((l) => ({
        purchaseOrderLineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        orderedQty: l.orderedQty,
        receivedQty: l.receivedQty,
        outstandingQty: Math.max(0, l.orderedQty - l.receivedQty),
        unitCostPaise: l.unitCostPaise,
      })),
    };
  }
}
