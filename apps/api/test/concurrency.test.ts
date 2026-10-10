import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actor,
  addStock,
  createBatch,
  createContext,
  createProduct,
  createStore,
  orderRef,
  type TestContext,
  type TestStore,
} from "./support/fixtures";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(60);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

const totals = async (productId: string) => {
  const res = await ctx.handle.db.execute<{ on_hand: number; reserved: number }>(sql`
    SELECT COALESCE(SUM(on_hand), 0)::int AS on_hand, COALESCE(SUM(reserved), 0)::int AS reserved
    FROM inventory_balances WHERE product_id = ${productId} AND status = 'available'`);
  return res.rows[0]!;
};

describe("concurrent reservations", () => {
  it("never reserves more than the 10 eligible units when 50 orders arrive at once", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const b1 = await createBatch(ctx, productId, 3);
    const b2 = await createBatch(ctx, productId, 9);
    await addStock(ctx, store, { productId, batchId: b1, quantity: 4, locationId: store.binA });
    await addStock(ctx, store, { productId, batchId: b2, quantity: 3, locationId: store.binA });
    await addStock(ctx, store, { productId, batchId: b2, quantity: 3, locationId: store.binB });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
      ),
    );

    const reserved = results.reduce((sum, r) => sum + r.lines[0]!.reservedQty, 0);
    expect(reserved).toBe(10);
    expect(results.filter((r) => r.fullyReserved)).toHaveLength(10);
    expect(results.filter((r) => r.lines[0]!.shortQty === 1)).toHaveLength(40);
    expect(await totals(productId)).toEqual({ on_hand: 10, reserved: 10 });
    expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
  });

  it("handles multi-item orders locking products in opposite line order without over-reserving", async () => {
    const a = await createProduct(ctx);
    const b = await createProduct(ctx);
    await addStock(ctx, store, { productId: a, quantity: 15, locationId: store.binA });
    await addStock(ctx, store, { productId: b, quantity: 40, locationId: store.binB });

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ctx.orders.acceptOrder(actor(store), {
          externalRef: orderRef(),
          lines:
            i % 2 === 0
              ? [
                  { productId: a, quantity: 1 },
                  { productId: b, quantity: 1 },
                ]
              : [
                  { productId: b, quantity: 1 },
                  { productId: a, quantity: 1 },
                ],
        }),
      ),
    );

    expect(results).toHaveLength(40);
    expect((await totals(a)).reserved).toBe(15);
    expect((await totals(b)).reserved).toBe(40);
    expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
  });

  it("stays consistent when cancellations race with new orders for the same stock", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 20 });

    const first = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
      ),
    );
    expect((await totals(productId)).reserved).toBe(20);

    // Cancel 10 while 30 more orders compete for whatever is released.
    const cancels = first
      .slice(0, 10)
      .map((o) => () => ctx.orders.cancelOrder(actor(store), o.orderId, "customer cancelled"));
    const accepts = Array.from(
      { length: 30 },
      () => () => ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
    );
    const mixed = [...cancels, ...accepts].sort(() => Math.random() - 0.5);
    const outcomes = await Promise.all(mixed.map((run) => run()));

    const newlyReserved = outcomes
      .filter((o): o is Awaited<ReturnType<typeof ctx.orders.acceptOrder>> => "lines" in o)
      .reduce((sum, o) => sum + o.lines[0]!.reservedQty, 0);
    const stillReserved = (await totals(productId)).reserved;

    expect(stillReserved).toBe(10 + newlyReserved);
    expect(stillReserved).toBeLessThanOrEqual(20);
    expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
  });
});
