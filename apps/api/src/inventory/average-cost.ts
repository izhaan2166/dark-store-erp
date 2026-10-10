import { sql } from "drizzle-orm";
import type { DbExecutor } from "@dse/db";

/**
 * Folds `qty` units worth `valuePaise` into the product's moving weighted-
 * average cost over everything now on hand. Call it after the units are
 * posted, in the same transaction.
 */
export async function applyAverageCost(tx: DbExecutor, productId: string, qty: number, valuePaise: number): Promise<void> {
  await tx.execute(sql`
    WITH on_hand AS (
      SELECT coalesce(sum(on_hand), 0)::bigint AS total FROM inventory_balances WHERE product_id = ${productId}
    )
    UPDATE products p
    SET avg_unit_cost_paise = CASE
      WHEN p.avg_unit_cost_paise IS NULL OR on_hand.total <= ${qty} THEN round(${valuePaise}::numeric / ${qty})
      ELSE round((p.avg_unit_cost_paise::numeric * (on_hand.total - ${qty}) + ${valuePaise}) / on_hand.total)
    END
    FROM on_hand
    WHERE p.id = ${productId}`);
}
