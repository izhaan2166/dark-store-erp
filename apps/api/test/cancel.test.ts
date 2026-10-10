import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidStateTransitionError, ValidationError } from "../src/common/errors";
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
  ctx = createContext(20);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

describe("cancelling an order", () => {
  it("releases every open allocation, closes shortages and lets the stock be reserved again", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 3 });
    const order = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 5 }],
    });
    expect(order.lines[0]!.shortQty).toBe(2);

    const cancelled = await ctx.orders.cancelOrder(actor(store), order.orderId, "customer cancelled");
    expect(cancelled).toEqual({ orderId: order.orderId, status: "cancelled", releasedQty: 3 });

    const shortages = await ctx.handle.db.execute<{ status: string; resolution: string }>(sql`
      SELECT s.status, s.resolution FROM order_item_shortages s
      JOIN order_items i ON i.id = s.order_item_id WHERE i.order_id = ${order.orderId}`);
    expect(shortages.rows).toEqual([{ status: "resolved", resolution: "order_cancelled" }]);

    const next = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 3 }],
    });
    expect(next.fullyReserved).toBe(true);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("returns the same result for a retried cancel and rejects a second, different cancel", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 1 });
    const order = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 1 }],
    });

    const key = randomUUID();
    const first = await ctx.orders.cancelOrder(actor(store, key), order.orderId, "duplicate order");
    const retried = await ctx.orders.cancelOrder(actor(store, key), order.orderId, "duplicate order");
    expect(retried).toEqual(first);

    await expect(ctx.orders.cancelOrder(actor(store), order.orderId, "again")).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("releases stock only once when the same order is cancelled from two places at once", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 2 });
    const order = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 2 }],
    });

    const outcomes = await Promise.allSettled([
      ctx.orders.cancelOrder(actor(store), order.orderId, "manager"),
      ctx.orders.cancelOrder(actor(store), order.orderId, "timeout policy"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InvalidStateTransitionError);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("refuses to cancel an order that already has picked units", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 1 });
    const order = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 1 }],
    });
    await ctx.handle.db.execute(sql`UPDATE order_items SET picked_qty = 1 WHERE order_id = ${order.orderId}`);

    await expect(ctx.orders.cancelOrder(actor(store), order.orderId, "too late")).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  it("requires a reason", async () => {
    await expect(ctx.orders.cancelOrder(actor(store), randomUUID(), " ")).rejects.toBeInstanceOf(ValidationError);
  });
});
