import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuplicateOrderError, ProductUnavailableError, ValidationError } from "../src/common/errors";
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
  ctx = createContext(10);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

describe("accepting an order", () => {
  it("allocates exact batches earliest-expiry first and skips stock that cannot be sold", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const soon = await createBatch(ctx, productId, 5);
    const later = await createBatch(ctx, productId, 10);
    const latest = await createBatch(ctx, productId, 30);
    const expired = await createBatch(ctx, productId, -1);
    const expiresToday = await createBatch(ctx, productId, 0);

    await addStock(ctx, store, { productId, batchId: latest, quantity: 2, locationId: store.binA });
    await addStock(ctx, store, { productId, batchId: later, quantity: 4, locationId: store.binB });
    await addStock(ctx, store, { productId, batchId: soon, quantity: 4, locationId: store.binA });
    // None of these may ever be allocated:
    await addStock(ctx, store, { productId, batchId: expired, quantity: 5 });
    await addStock(ctx, store, { productId, batchId: expiresToday, quantity: 5 });
    await addStock(ctx, store, { productId, batchId: soon, quantity: 5, locationId: store.packing });
    await addStock(ctx, store, { productId, batchId: soon, quantity: 5, locationId: store.quarantine, status: "quarantined" });
    await addStock(ctx, store, { productId, batchId: soon, quantity: 5, status: "damaged" });

    const result = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 6 }],
    });

    expect(result.fullyReserved).toBe(true);
    const line = result.lines[0]!;
    expect(line.allocations.map((a) => [a.batchId, a.locationId, a.quantity])).toEqual([
      [soon, store.binA, 4],
      [later, store.binB, 2],
    ]);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("honours the store's sell-by cutoff", async () => {
    const cautious = await createStore(ctx, { sellByCutoffDays: 7 });
    const productId = await createProduct(ctx, { batchTracked: true });
    const withinCutoff = await createBatch(ctx, productId, 7);
    const beyondCutoff = await createBatch(ctx, productId, 8);
    await addStock(ctx, cautious, { productId, batchId: withinCutoff, quantity: 3 });
    await addStock(ctx, cautious, { productId, batchId: beyondCutoff, quantity: 1 });

    const result = await ctx.orders.acceptOrder(actor(cautious), {
      externalRef: orderRef(),
      lines: [{ productId, quantity: 2 }],
    });
    expect(result.lines[0]!.allocations.map((a) => a.batchId)).toEqual([beyondCutoff]);
    expect(result.lines[0]!.shortQty).toBe(1);
  });

  it("reserves what exists and opens a shortage for the rest", async () => {
    const plenty = await createProduct(ctx);
    const scarce = await createProduct(ctx);
    const none = await createProduct(ctx);
    await addStock(ctx, store, { productId: plenty, quantity: 10 });
    await addStock(ctx, store, { productId: scarce, quantity: 2 });

    const result = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [
        { productId: plenty, quantity: 3 },
        { productId: scarce, quantity: 3 },
        { productId: none, quantity: 1 },
      ],
    });

    expect(result.status).toBe("accepted");
    expect(result.fullyReserved).toBe(false);
    expect(result.lines.map((l) => [l.requestedQty, l.reservedQty, l.shortQty])).toEqual([
      [3, 3, 0],
      [3, 2, 1],
      [1, 0, 1],
    ]);

    const shortages = await ctx.handle.db.execute<{ quantity: number; source: string; status: string }>(sql`
      SELECT s.quantity, s.source, s.status
      FROM order_item_shortages s JOIN order_items i ON i.id = s.order_item_id
      WHERE i.order_id = ${result.orderId}
      ORDER BY i.line_no`);
    expect(shortages.rows).toEqual([
      { quantity: 1, source: "reservation", status: "open" },
      { quantity: 1, source: "reservation", status: "open" },
    ]);

    const events = await ctx.handle.db.execute<{ event_type: string }>(sql`
      SELECT event_type FROM outbox_events WHERE payload->>'orderId' = ${result.orderId}`);
    expect(events.rows).toEqual([{ event_type: "order.accepted" }]);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("does not change on-hand stock when reserving", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 4 });
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
    const rows = await ctx.handle.db.execute<{ on_hand: number; reserved: number }>(sql`
      SELECT on_hand, reserved FROM inventory_balances WHERE product_id = ${productId}`);
    expect(rows.rows).toEqual([{ on_hand: 4, reserved: 3 }]);
  });

  it("rejects inactive products, duplicate lines and duplicate external references", async () => {
    const inactive = await createProduct(ctx, { status: "inactive" });
    await expect(
      ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId: inactive, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ProductUnavailableError);

    const productId = await createProduct(ctx);
    await expect(
      ctx.orders.acceptOrder(actor(store), {
        externalRef: orderRef(),
        lines: [
          { productId, quantity: 1 },
          { productId, quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const ref = orderRef();
    await ctx.orders.acceptOrder(actor(store), { externalRef: ref, lines: [{ productId, quantity: 1 }] });
    await expect(
      ctx.orders.acceptOrder(actor(store), { externalRef: ref, lines: [{ productId, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(DuplicateOrderError);
  });
});
