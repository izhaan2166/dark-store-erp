import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbHandle } from "@dse/db";
import { NotFoundError } from "../common/errors";
import { DB_HANDLE } from "../database/database.tokens";

export interface DashboardView {
  /** The store's own date, which "today" means throughout. */
  today: string;
  expiryAlertDays: number;
  kpis: {
    handedOverToday: number;
    /** Median minutes from accepting an order to handing it over, for today's orders; null before the first. */
    medianFulfilmentMinutes: number | null;
    awaitingFulfilment: number;
    outOfStock: number;
    expiryAlerts: number;
  };
  exceptions: {
    openShortages: number;
    escalatedShortages: number;
    receiptsAwaitingApproval: number;
    countsAwaitingApproval: number;
    requestsAwaitingApproval: number;
    unitsAwaitingPutaway: number;
    problemOrders: number;
  };
}

export type HandedOverRow = {
  orderId: string;
  externalRef: string;
  createdAt: string;
  handedOverAt: string;
  minutes: number;
};

export type OutOfStockRow = {
  productId: string;
  sku: string;
  name: string;
  /** Units on order for customers that could not be reserved. */
  openShortageUnits: number;
};

export type ExpiringRow = {
  productId: string;
  sku: string;
  name: string;
  batchId: string;
  lotCode: string;
  expiryDate: string;
  locationCode: string;
  status: string;
  onHand: number;
};

/** Orders still being worked on, as the order list counts them. */
const AWAITING = sql`('accepted', 'picking', 'packing', 'ready_for_handover', 'exception')`;

/**
 * The Store Manager's dashboard: a few numbers and the exceptions waiting on
 * someone. Every figure is read straight from the order and inventory
 * records, and each KPI has a list endpoint returning exactly the rows it
 * counted, so a number can always be checked.
 *
 * Definitions (the store's time zone sets "today"):
 * - handed over today: orders now `handed_over` whose handover happened today;
 * - awaiting fulfilment: orders accepted, picking, packing, ready or in exception;
 * - out of stock: active products this store has stocked that have nothing
 *   available to promise (the same rule reservation uses);
 * - expiry alerts: lots with units on hand that are on sale or blocked and
 *   expire within `expiry_alert_days`, expired ones included until written off.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async summary(storeId: string): Promise<DashboardView> {
    const result = await this.handle.db.execute<Record<string, unknown>>(sql`
      WITH s AS (${this.settings(storeId)}),
      done AS (
        SELECT extract(epoch FROM o.updated_at - o.created_at) / 60 AS minutes
        FROM orders o, s
        WHERE o.store_id = ${storeId} AND o.status = 'handed_over' AND o.updated_at >= s.day_start
      )
      SELECT s.today, s.expiry_alert_days,
        (SELECT count(*) FROM done)::int AS handed_over_today,
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::int FROM done) AS median_minutes,
        (SELECT count(*) FROM orders WHERE store_id = ${storeId} AND status IN ${AWAITING})::int AS awaiting,
        (SELECT count(*) FROM (${this.outOfStockQuery(storeId)}) x)::int AS out_of_stock,
        (SELECT count(DISTINCT batch_id) FROM (${this.expiringQuery(storeId)}) x)::int AS expiry_alerts,
        (SELECT count(*) FROM order_item_shortages sh JOIN order_items i ON i.id = sh.order_item_id
           JOIN orders o ON o.id = i.order_id WHERE o.store_id = ${storeId} AND sh.status = 'open')::int AS open_shortages,
        (SELECT count(*) FROM order_item_shortages sh JOIN order_items i ON i.id = sh.order_item_id
           JOIN orders o ON o.id = i.order_id WHERE o.store_id = ${storeId} AND sh.status = 'open' AND sh.escalated_at IS NOT NULL)::int AS escalated,
        (SELECT count(*) FROM goods_receipts WHERE store_id = ${storeId} AND status = 'pending_approval')::int AS receipts,
        (SELECT count(*) FROM stock_counts WHERE store_id = ${storeId} AND status = 'pending_approval')::int AS counts,
        (SELECT count(*) FROM stock_requests WHERE store_id = ${storeId} AND status = 'pending_approval')::int AS requests,
        (SELECT coalesce(sum(on_hand), 0) FROM inventory_balances WHERE store_id = ${storeId} AND status = 'receiving')::int AS putaway_units,
        (SELECT count(*) FROM orders WHERE store_id = ${storeId} AND status = 'exception')::int AS problem_orders
      FROM s`);
    const row = result.rows[0];
    if (!row) throw new NotFoundError("Store not found", { storeId });
    const n = (key: string) => Number(row[key]);
    return {
      today: String(row.today),
      expiryAlertDays: n("expiry_alert_days"),
      kpis: {
        handedOverToday: n("handed_over_today"),
        medianFulfilmentMinutes: row.median_minutes === null ? null : n("median_minutes"),
        awaitingFulfilment: n("awaiting"),
        outOfStock: n("out_of_stock"),
        expiryAlerts: n("expiry_alerts"),
      },
      exceptions: {
        openShortages: n("open_shortages"),
        escalatedShortages: n("escalated"),
        receiptsAwaitingApproval: n("receipts"),
        countsAwaitingApproval: n("counts"),
        requestsAwaitingApproval: n("requests"),
        unitsAwaitingPutaway: n("putaway_units"),
        problemOrders: n("problem_orders"),
      },
    };
  }

  /** The orders counted as handed over today, latest first. */
  async handedOverToday(storeId: string): Promise<HandedOverRow[]> {
    const result = await this.handle.db.execute<HandedOverRow>(sql`
      WITH s AS (${this.settings(storeId)})
      SELECT o.id AS "orderId", o.external_ref AS "externalRef", o.created_at AS "createdAt", o.updated_at AS "handedOverAt",
             round(extract(epoch FROM o.updated_at - o.created_at) / 60)::int AS minutes
      FROM orders o, s
      WHERE o.store_id = ${storeId} AND o.status = 'handed_over' AND o.updated_at >= s.day_start
      ORDER BY o.updated_at DESC, o.id
      LIMIT 500`);
    return result.rows;
  }

  /** The products counted as out of stock, the ones customers are waiting for first. */
  async outOfStock(storeId: string): Promise<OutOfStockRow[]> {
    const result = await this.handle.db.execute<OutOfStockRow>(sql`
      SELECT x.product_id AS "productId", p.sku, p.name,
             coalesce((SELECT sum(sh.quantity) FROM order_item_shortages sh
                       JOIN order_items i ON i.id = sh.order_item_id JOIN orders o ON o.id = i.order_id
                       WHERE o.store_id = ${storeId} AND sh.status = 'open' AND i.product_id = x.product_id), 0)::int
               AS "openShortageUnits"
      FROM (${this.outOfStockQuery(storeId)}) x
      JOIN products p ON p.id = x.product_id
      ORDER BY "openShortageUnits" DESC, p.sku
      LIMIT 500`);
    return result.rows;
  }

  /** The stock counted as expiry alerts, soonest first. */
  async expiring(storeId: string): Promise<ExpiringRow[]> {
    const result = await this.handle.db.execute<ExpiringRow>(sql`
      SELECT x.product_id AS "productId", p.sku, p.name, x.batch_id AS "batchId", bt.lot_code AS "lotCode",
             to_char(bt.expiry_date, 'YYYY-MM-DD') AS "expiryDate", l.code AS "locationCode", x.status, x.on_hand AS "onHand"
      FROM (${this.expiringQuery(storeId)}) x
      JOIN products p ON p.id = x.product_id
      JOIN batches bt ON bt.id = x.batch_id
      JOIN locations l ON l.id = x.location_id
      ORDER BY bt.expiry_date, p.sku, l.code
      LIMIT 500`);
    return result.rows;
  }

  private settings(storeId: string) {
    return sql`
      SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today,
             ((now() AT TIME ZONE timezone)::date)::timestamp AT TIME ZONE timezone AS day_start,
             (now() AT TIME ZONE timezone)::date + sell_by_cutoff_days AS cutoff,
             (now() AT TIME ZONE timezone)::date + expiry_alert_days AS alert_until,
             expiry_alert_days
      FROM store_settings WHERE store_id = ${storeId}`;
  }

  /** Active products with a balance row in this store and nothing available to promise. */
  private outOfStockQuery(storeId: string) {
    return sql`
      SELECT b.product_id
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id AND p.status = 'active'
      JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id
      CROSS JOIN (${this.settings(storeId)}) s
      WHERE b.store_id = ${storeId}
      GROUP BY b.product_id
      HAVING coalesce(sum(b.on_hand - b.reserved) FILTER (
        WHERE b.status = 'available' AND l.allocatable AND l.status = 'active'
          AND (bt.expiry_date IS NULL OR bt.expiry_date > s.cutoff)), 0) <= 0`;
  }

  /** Balance rows of lots on sale or blocked that expire within the alert window. */
  private expiringQuery(storeId: string) {
    return sql`
      SELECT b.product_id, b.batch_id, b.location_id, b.status, b.on_hand
      FROM inventory_balances b
      JOIN batches bt ON bt.id = b.batch_id
      CROSS JOIN (${this.settings(storeId)}) s
      WHERE b.store_id = ${storeId} AND b.on_hand > 0
        AND b.status IN ('available', 'quarantined', 'expired')
        AND bt.expiry_date <= s.alert_until`;
  }
}
