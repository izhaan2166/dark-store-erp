import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientStockError } from "../src/common/errors";
import { addStock, createContext, createProduct, createStore, type TestContext, type TestStore } from "./support/fixtures";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(10);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

/** Postgres error text, unwrapped from Drizzle's query error. */
const dbError = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return cause?.message ?? (err as Error).message;
  }
  throw new Error("Expected the database to reject the statement");
};

const balance = async (productId: string, locationId: string, status = "available") => {
  const res = await ctx.handle.db.execute<{ on_hand: number; reserved: number }>(sql`
    SELECT on_hand, reserved FROM inventory_balances
    WHERE product_id = ${productId} AND location_id = ${locationId} AND status = ${status}`);
  return res.rows[0] ?? { on_hand: 0, reserved: 0 };
};

describe("ledger", () => {
  it("records each receipt as a movement and updates the balance by exactly that quantity", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 10 });
    expect((await balance(productId, store.binA)).on_hand).toBe(10);

    const moves = await ctx.handle.db.execute<{ quantity: number }>(sql`
      SELECT quantity FROM inventory_movements WHERE product_id = ${productId}`);
    expect(moves.rows).toEqual([{ quantity: 10 }]);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("moves stock between buckets without changing the total", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 10 });
    await ctx.ledger.post({
      storeId: store.storeId,
      productId,
      batchId: null,
      quantity: 3,
      movementType: "status_change",
      sourceType: "inspection",
      sourceId: randomUUID(),
      actorUserId: store.userId,
      reason: "crushed packaging",
      from: { locationId: store.binA, status: "available" },
      to: { locationId: store.quarantine, status: "damaged" },
    });
    expect((await balance(productId, store.binA)).on_hand).toBe(7);
    expect((await balance(productId, store.quarantine, "damaged")).on_hand).toBe(3);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("refuses to move more than the unreserved quantity", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 2 });
    await expect(
      ctx.ledger.post({
        storeId: store.storeId,
        productId,
        batchId: null,
        quantity: 3,
        movementType: "transfer",
        sourceType: "transfer",
        sourceId: randomUUID(),
        actorUserId: store.userId,
        from: { locationId: store.binA, status: "available" },
        to: { locationId: store.binB, status: "available" },
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await balance(productId, store.binA)).on_hand).toBe(2);
  });

  it("blocks edits and deletes of movement history at the database level", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 1 });
    expect(
      await dbError(ctx.handle.db.execute(sql`UPDATE inventory_movements SET quantity = 99 WHERE product_id = ${productId}`)),
    ).toMatch(/append-only/);
    expect(
      await dbError(ctx.handle.db.execute(sql`DELETE FROM inventory_movements WHERE product_id = ${productId}`)),
    ).toMatch(/append-only/);
  });

  it("rejects a balance where reserved exceeds on hand, or blocked stock carries a reservation", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 1 });
    expect(
      await dbError(ctx.handle.db.execute(sql`UPDATE inventory_balances SET reserved = 2 WHERE product_id = ${productId}`)),
    ).toMatch(/inventory_balances_reserved_within_on_hand/);

    await addStock(ctx, store, { productId, quantity: 1, locationId: store.quarantine, status: "quarantined" });
    expect(
      await dbError(
        ctx.handle.db.execute(sql`
          UPDATE inventory_balances SET reserved = 1
          WHERE product_id = ${productId} AND status = 'quarantined'`),
      ),
    ).toMatch(/inventory_balances_reserved_only_available/);
  });

  it("reports a balance that no longer matches its movements", async () => {
    const isolated = await createStore(ctx);
    const productId = await createProduct(ctx);
    await addStock(ctx, isolated, { productId, quantity: 5 });
    await ctx.handle.db.execute(sql`UPDATE inventory_balances SET on_hand = 6 WHERE product_id = ${productId}`);
    const report = await ctx.reconciliation.run(isolated.storeId);
    expect(report.ok).toBe(false);
    expect(report.onHand).toEqual([expect.objectContaining({ productId, ledgerQty: 5, balanceQty: 6 })]);
  });
});
