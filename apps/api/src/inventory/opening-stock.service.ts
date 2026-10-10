import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, batches, locations, products, storeSettings, type DbExecutor, type DbHandle } from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { ConflictError, NotFoundError, ProductUnavailableError, ValidationError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { applyAverageCost } from "./average-cost";
import { LedgerService } from "./ledger.service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const openingStockSchema = z.object({
  locationId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(1_000_000),
        lotCode: z.string().trim().min(1).max(100).optional(),
        expiryDate: isoDate.optional(),
        /** Cost of one unit, if known; it seeds the product's average cost. */
        unitCostPaise: z.number().int().min(0).max(100_000_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type OpeningStockRequest = z.input<typeof openingStockSchema>;

export interface OpeningStockView {
  openingStockId: string;
  locationId: string;
  lines: { productId: string; batchId: string | null; quantity: number }[];
}

/**
 * Loads the counted stock of one storage location when the store starts
 * using the system: one opening-balance movement per product and batch,
 * straight into available stock.
 *
 * A location can be loaded once, and only while it has no stock history:
 * after go-live, differences go through stock counts and their approvals,
 * never through another opening load. The location row is locked first, so
 * two loads, or a load and a putaway, into the same location cannot overlap.
 */
@Injectable()
export class OpeningStockService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async load(actor: Actor, request: OpeningStockRequest): Promise<OpeningStockView> {
    const body = parse(openingStockSchema, request, "Invalid opening stock");
    const keys = body.lines.map((l) => `${l.productId}:${l.lotCode ?? ""}`);
    if (new Set(keys).size !== keys.length) throw new ValidationError("Enter each product and lot once");

    return withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope: "opening_stock.load", key: actor.idempotencyKey, request: body }, () =>
          this.loadInTx(tx, actor, body),
        ),
      ),
    );
  }

  private async loadInTx(tx: DbExecutor, actor: Actor, body: z.output<typeof openingStockSchema>): Promise<OpeningStockView> {
    const [location] = await tx
      .select({ purpose: locations.purpose, status: locations.status })
      .from(locations)
      .where(and(eq(locations.id, body.locationId), eq(locations.storeId, actor.storeId)))
      .for("update");
    if (!location) throw new NotFoundError("Location not found", { locationId: body.locationId });
    if (location.purpose !== "storage" || location.status !== "active") {
      throw new ValidationError("Opening stock goes into an active storage location", { locationId: body.locationId });
    }
    const history = await tx.execute(sql`
      SELECT 1 FROM inventory_movements
      WHERE from_location_id = ${body.locationId} OR to_location_id = ${body.locationId}
      LIMIT 1`);
    if (history.rows.length > 0) {
      throw new ConflictError("This location already has stock history. Use a stock count to correct it.", {
        locationId: body.locationId,
      });
    }

    const productIds = [...new Set(body.lines.map((l) => l.productId))].sort();
    await tx.execute(sql`SELECT id FROM products WHERE id IN ${productIds} ORDER BY id FOR UPDATE`);
    const found = await tx.select().from(products).where(inArray(products.id, productIds));
    const byId = new Map(found.map((p) => [p.id, p]));
    const unavailable = productIds.filter((id) => byId.get(id)?.status !== "active");
    if (unavailable.length) throw new ProductUnavailableError("Some products are unknown or inactive", { productIds: unavailable });

    const [settings] = await tx
      .select({ today: sql<string>`to_char((now() AT TIME ZONE ${storeSettings.timezone})::date, 'YYYY-MM-DD')` })
      .from(storeSettings)
      .where(eq(storeSettings.storeId, actor.storeId));
    if (!settings) throw new NotFoundError("Store settings not found", { storeId: actor.storeId });

    const openingStockId = randomUUID();
    const lines: OpeningStockView["lines"] = [];
    for (const line of body.lines) {
      const batchId = await this.resolveBatch(tx, byId.get(line.productId)!, line, settings.today);
      await this.ledger.postIn(tx, {
        storeId: actor.storeId,
        productId: line.productId,
        batchId,
        quantity: line.quantity,
        movementType: "opening_balance",
        sourceType: "opening_stock",
        sourceId: openingStockId,
        actorUserId: actor.actorUserId,
        to: { locationId: body.locationId, status: "available" },
      });
      lines.push({ productId: line.productId, batchId, quantity: line.quantity });
    }

    for (const productId of productIds) {
      const costed = body.lines.filter((l) => l.productId === productId && l.unitCostPaise !== undefined);
      const qty = costed.reduce((n, l) => n + l.quantity, 0);
      if (qty > 0) await applyAverageCost(tx, productId, qty, costed.reduce((n, l) => n + l.quantity * l.unitCostPaise!, 0));
    }

    await tx.insert(auditLogs).values({
      storeId: actor.storeId,
      actorUserId: actor.actorUserId,
      action: "opening_stock.load",
      entityType: "location",
      entityId: body.locationId,
      after: { openingStockId, ...body },
    });
    return { openingStockId, locationId: body.locationId, lines };
  }

  /** Finds or creates the batch for a batch-tracked line; expired lots are refused. */
  private async resolveBatch(
    tx: DbExecutor,
    product: typeof products.$inferSelect,
    line: z.output<typeof openingStockSchema>["lines"][number],
    today: string,
  ): Promise<string | null> {
    if (!product.batchTracked) {
      if (line.lotCode || line.expiryDate) {
        throw new ValidationError("This product is not batch tracked; leave out lot and expiry", { productId: product.id });
      }
      return null;
    }
    if (!line.lotCode || !line.expiryDate) {
      throw new ValidationError("Lot code and expiry date are required for batch-tracked products", { productId: product.id });
    }
    if (line.expiryDate <= today) {
      throw new ValidationError("Expired stock cannot be loaded as sellable stock", {
        productId: product.id,
        expiryDate: line.expiryDate,
      });
    }
    await tx.insert(batches).values({ productId: product.id, lotCode: line.lotCode, expiryDate: line.expiryDate }).onConflictDoNothing();
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
