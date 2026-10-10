import { eq, sql } from "drizzle-orm";
import { orderItems, reservationAllocations, storeSettings, type DbExecutor } from "@dse/db";

export type EligibleRow = {
  id: string;
  product_id: string;
  batch_id: string | null;
  location_id: string;
  on_hand: number;
  reserved: number;
  expiry_date: string | null;
};

export interface AllocationView {
  balanceId: number;
  locationId: string;
  batchId: string | null;
  expiryDate: string | null;
  quantity: number;
}

/**
 * Locks every balance row that new reservations may draw on for these
 * products: available stock in active, allocatable bins, with a batch beyond
 * the store's sell-by cutoff. Rows are locked in primary-key order, the one
 * lock order every stock transaction uses; FEFO is applied afterwards.
 */
export async function lockEligibleBalances(tx: DbExecutor, storeId: string, productIds: string[]): Promise<EligibleRow[]> {
  if (productIds.length === 0) return [];
  const [settings] = await tx
    .select({ timezone: storeSettings.timezone, cutoff: storeSettings.sellByCutoffDays })
    .from(storeSettings)
    .where(eq(storeSettings.storeId, storeId));
  if (!settings) throw new Error(`Store ${storeId} has no settings`);
  const result = await tx.execute<EligibleRow>(sql`
    SELECT b.id, b.product_id, b.batch_id, b.location_id, b.on_hand, b.reserved,
           to_char(bt.expiry_date, 'YYYY-MM-DD') AS expiry_date
    FROM inventory_balances b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN batches bt ON bt.id = b.batch_id
    WHERE b.store_id = ${storeId}
      AND b.product_id IN (${sql.join(
        productIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND b.status = 'available'
      AND l.allocatable
      AND l.status = 'active'
      AND (bt.expiry_date IS NULL
           OR bt.expiry_date > (now() AT TIME ZONE ${settings.timezone})::date + ${settings.cutoff}::int)
    ORDER BY b.id
    FOR UPDATE OF b`);
  return result.rows;
}

/**
 * Reserves up to `quantity` of one order line from already-locked rows,
 * earliest expiry first. Records the allocations, raises `reserved` on each
 * balance row and the line's `reserved_qty`, and updates `eligible` in place
 * so later lines see what is left. Returns what could not be covered.
 */
export async function allocateLine(
  tx: DbExecutor,
  line: { reservationId: string; orderItemId: string; productId: string; quantity: number },
  eligible: EligibleRow[],
): Promise<{ allocations: AllocationView[]; remaining: number }> {
  const candidates = eligible.filter((r) => r.product_id === line.productId && r.on_hand - r.reserved > 0).sort(fefo);

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

  if (allocations.length > 0) {
    await tx.insert(reservationAllocations).values(
      allocations.map((a) => ({
        reservationId: line.reservationId,
        orderItemId: line.orderItemId,
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
    await tx
      .update(orderItems)
      .set({ reservedQty: sql`${orderItems.reservedQty} + ${line.quantity - remaining}` })
      .where(eq(orderItems.id, line.orderItemId));
  }
  return { allocations, remaining };
}

function fefo(a: EligibleRow, b: EligibleRow): number {
  if (a.expiry_date !== b.expiry_date) {
    if (a.expiry_date === null) return 1;
    if (b.expiry_date === null) return -1;
    return a.expiry_date < b.expiry_date ? -1 : 1;
  }
  return Number(a.id) - Number(b.id);
}
