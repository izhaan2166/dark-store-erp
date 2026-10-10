import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdempotencyConflictError } from "../src/common/errors";
import {
  actor,
  addStock,
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
  ctx = createContext(30);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

const reservedFor = async (productId: string) => {
  const res = await ctx.handle.db.execute<{ reserved: number }>(sql`
    SELECT COALESCE(SUM(reserved), 0)::int AS reserved FROM inventory_balances WHERE product_id = ${productId}`);
  return res.rows[0]!.reserved;
};

describe("idempotent writes", () => {
  it("returns the original result when the same request is retried", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const key = randomUUID();
    const request = { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] };

    const first = await ctx.orders.acceptOrder(actor(store, key), request);
    const retry = await ctx.orders.acceptOrder(actor(store, key), request);

    expect(retry).toEqual(first);
    expect(await reservedFor(productId)).toBe(2);
  });

  it("reserves once when the same request arrives many times at once", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const key = randomUUID();
    const request = { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx.orders.acceptOrder(actor(store, key), request)),
    );

    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await reservedFor(productId)).toBe(2);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("rejects the same key with a different payload", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const key = randomUUID();
    const ref = orderRef();
    await ctx.orders.acceptOrder(actor(store, key), { externalRef: ref, lines: [{ productId, quantity: 1 }] });

    await expect(
      ctx.orders.acceptOrder(actor(store, key), { externalRef: ref, lines: [{ productId, quantity: 3 }] }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await reservedFor(productId)).toBe(1);
  });

  it("treats payloads with the same content in a different key order as the same request", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const key = randomUUID();
    const ref = orderRef();
    const first = await ctx.orders.acceptOrder(actor(store, key), { externalRef: ref, lines: [{ productId, quantity: 1 }] });
    const again = await ctx.orders.acceptOrder(actor(store, key), {
      lines: [{ quantity: 1, productId }],
      externalRef: ref,
    });
    expect(again.orderId).toBe(first.orderId);
  });
});
