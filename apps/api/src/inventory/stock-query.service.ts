import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbHandle } from "@dse/db";
import { z } from "zod";
import { NotFoundError } from "../common/errors";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import type { StockStatus } from "./ledger.service";

export const balanceQuerySchema = z.object({
  productId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  status: z.enum(["receiving", "available", "quarantined", "damaged", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export type BalanceView = {
  productId: string;
  sku: string;
  locationId: string;
  locationCode: string;
  batchId: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  status: StockStatus;
  onHand: number;
  reserved: number;
  free: number;
};

export interface ProductStockView {
  productId: string;
  /** Units physically in the store, by stock status. */
  onHand: Record<StockStatus, number>;
  reserved: number;
  /** What new orders can still reserve: free units in sellable bins, beyond the sell-by cutoff. */
  availableToPromise: number;
  /** Free available units in sellable bins that are expired or inside the sell-by cutoff. */
  nearExpiryBlocked: number;
}

/** Read-only stock views for screens and reports. */
@Injectable()
export class StockQueryService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async listBalances(storeId: string, query: unknown): Promise<{ items: BalanceView[]; limit: number; offset: number }> {
    const q = parse(balanceQuerySchema, query, "Invalid stock query");
    const result = await this.handle.db.execute<BalanceView>(sql`
      SELECT b.product_id AS "productId", p.sku, b.location_id AS "locationId", l.code AS "locationCode",
             b.batch_id AS "batchId", bt.lot_code AS "lotCode",
             to_char(bt.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
             b.status, b.on_hand AS "onHand", b.reserved, b.on_hand - b.reserved AS free
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id
      JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE b.store_id = ${storeId}
        AND (b.on_hand > 0 OR b.reserved > 0)
        ${q.productId ? sql`AND b.product_id = ${q.productId}` : sql``}
        ${q.locationId ? sql`AND b.location_id = ${q.locationId}` : sql``}
        ${q.status ? sql`AND b.status = ${q.status}` : sql``}
      ORDER BY p.sku, l.code, bt.expiry_date NULLS LAST, b.id
      LIMIT ${q.limit} OFFSET ${q.offset}`);
    return { items: result.rows, limit: q.limit, offset: q.offset };
  }

  async productStock(storeId: string, productId: string): Promise<ProductStockView> {
    const result = await this.handle.db.execute<{
      status: StockStatus;
      on_hand: number;
      reserved: number;
      sellable: number;
      blocked: number;
    }>(sql`
      WITH settings AS (
        SELECT (now() AT TIME ZONE timezone)::date + sell_by_cutoff_days AS cutoff
        FROM store_settings WHERE store_id = ${storeId}
      )
      SELECT b.status,
             sum(b.on_hand)::int AS on_hand,
             sum(b.reserved)::int AS reserved,
             coalesce(sum(b.on_hand - b.reserved) FILTER (
               WHERE b.status = 'available' AND l.allocatable AND l.status = 'active'
                 AND (bt.expiry_date IS NULL OR bt.expiry_date > s.cutoff)), 0)::int AS sellable,
             coalesce(sum(b.on_hand - b.reserved) FILTER (
               WHERE b.status = 'available' AND l.allocatable AND l.status = 'active'
                 AND bt.expiry_date <= s.cutoff), 0)::int AS blocked
      FROM inventory_balances b
      CROSS JOIN settings s
      JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE b.store_id = ${storeId} AND b.product_id = ${productId}
      GROUP BY b.status`);

    const [exists] = (await this.handle.db.execute(sql`SELECT 1 FROM products WHERE id = ${productId}`)).rows;
    if (!exists) throw new NotFoundError("Product not found", { productId });

    const view: ProductStockView = {
      productId,
      onHand: { receiving: 0, available: 0, quarantined: 0, damaged: 0, expired: 0 },
      reserved: 0,
      availableToPromise: 0,
      nearExpiryBlocked: 0,
    };
    for (const row of result.rows) {
      view.onHand[row.status] = row.on_hand;
      view.reserved += row.reserved;
      view.availableToPromise += row.sellable;
      view.nearExpiryBlocked += row.blocked;
    }
    return view;
  }
}
