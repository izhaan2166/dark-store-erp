import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { inventoryBalances, orderItems, orderItemShortages, outboxEvents, productBarcodes, products } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(30);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

async function scannable(): Promise<{ productId: string; barcode: string }> {
  const productId = await createProduct(ctx);
  const barcode = `BC${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
  return { productId, barcode };
}

/** An order for 3 of a product with only 1 in stock: a 2-unit reservation shortage. */
async function shortOrder() {
  const original = await scannable();
  await addStock(ctx, store, { productId: original.productId, quantity: 1 });
  const accepted = await ctx.orders.acceptOrder(actor(store), {
    externalRef: orderRef(),
    lines: [{ productId: original.productId, quantity: 3 }],
  });
  const view = await ctx.fulfilment.view(store.storeId, accepted.orderId);
  return { original, orderId: accepted.orderId, itemId: accepted.lines[0]!.orderItemId, shortageId: view.openShortages[0]!.shortageId };
}

const substitute = (orderId: string, shortageId: string, substituteProductId: string, quantity: number) =>
  ctx.fulfilment.resolveShortage(actor(store), orderId, shortageId, {
    resolution: "substitute",
    substituteProductId,
    quantity,
    reason: "Customer accepts the other brand",
  });

async function expectReconciled() {
  expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
}

async function lineCount(orderId: string) {
  return (await ctx.handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderId))).length;
}

describe("substitutions", () => {
  it("adds a reserved line for the substitute and carries it through to handover", async () => {
    const { original, orderId, itemId, shortageId } = await shortOrder();
    const replacement = await scannable();
    await addStock(ctx, store, { productId: replacement.productId, quantity: 5 });

    const view = await substitute(orderId, shortageId, replacement.productId, 2);
    expect(view.openShortages).toEqual([]);
    expect(view.lines).toMatchObject([
      { orderItemId: itemId, lineNo: 1, requestedQty: 3, reservedQty: 1, substitutesItemId: null },
      { lineNo: 2, productId: replacement.productId, requestedQty: 2, reservedQty: 2, substitutesItemId: itemId },
    ]);
    const [resolved] = await ctx.handle.db.select().from(orderItemShortages).where(eq(orderItemShortages.id, shortageId));
    expect(resolved).toMatchObject({ status: "resolved", resolution: "substituted", resolvedBy: store.userId });
    const events = await ctx.handle.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, "order.item_substituted"), sql`${outboxEvents.payload}->>'orderId' = ${orderId}`));
    expect(events).toHaveLength(1);
    expect((await ctx.orders.getOrder(store.storeId, orderId)).lines[1]!.substitutesItemId).toBe(itemId);

    const newItemId = view.lines[1]!.orderItemId;
    await ctx.fulfilment.startPicking(actor(store), orderId);
    await ctx.fulfilment.pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode: original.barcode, quantity: 1 });
    await ctx.fulfilment.pick(actor(store), orderId, {
      orderItemId: newItemId,
      locationId: store.binA,
      barcode: replacement.barcode,
      quantity: 2,
    });
    await ctx.fulfilment.completePicking(actor(store), orderId);
    const packed = await ctx.fulfilment.pack(actor(store), orderId, {
      lines: [
        { orderItemId: itemId, quantity: 1 },
        { orderItemId: newItemId, quantity: 2 },
      ],
    });
    expect(packed.status).toBe("ready_for_handover");
    expect((await ctx.fulfilment.handover(actor(store), orderId)).status).toBe("handed_over");
    await expectReconciled();
  });

  it("refuses the same product, an inactive product or too little stock, and changes nothing", async () => {
    const { original, orderId, shortageId } = await shortOrder();
    await expect(substitute(orderId, shortageId, original.productId, 2)).rejects.toThrow(/different product/);

    const inactive = await createProduct(ctx, { status: "inactive" });
    await expect(substitute(orderId, shortageId, inactive, 2)).rejects.toThrow(/unknown or inactive/);

    const scarce = await createProduct(ctx);
    await addStock(ctx, store, { productId: scarce, quantity: 1 });
    await expect(substitute(orderId, shortageId, scarce, 2)).rejects.toThrow(/Not enough sellable stock of the substitute/);

    expect(await lineCount(orderId)).toBe(1);
    const [stillOpen] = await ctx.handle.db.select().from(orderItemShortages).where(eq(orderItemShortages.id, shortageId));
    expect(stillOpen!.status).toBe("open");
    const [scarceRow] = await ctx.handle.db.select().from(inventoryBalances).where(eq(inventoryBalances.productId, scarce));
    expect(scarceRow!.reserved).toBe(0);
    await expectReconciled();
  });

  it("sends an order in packing back to picking", async () => {
    const original = await scannable();
    await addStock(ctx, store, { productId: original.productId, quantity: 2 });
    const accepted = await ctx.orders.acceptOrder(actor(store), {
      externalRef: orderRef(),
      lines: [{ productId: original.productId, quantity: 2 }],
    });
    const { orderId } = accepted;
    const itemId = accepted.lines[0]!.orderItemId;
    await ctx.fulfilment.startPicking(actor(store), orderId);
    await ctx.fulfilment.pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode: original.barcode, quantity: 1 });
    const short = await ctx.fulfilment.shortPick(actor(store), orderId, {
      orderItemId: itemId,
      locationId: store.binA,
      quantity: 1,
      reason: "Torn packet",
    });
    expect((await ctx.fulfilment.completePicking(actor(store), orderId)).status).toBe("packing");

    const replacement = await scannable();
    await addStock(ctx, store, { productId: replacement.productId, quantity: 1 });
    const view = await substitute(orderId, short.openShortages[0]!.shortageId, replacement.productId, 1);
    expect(view.status).toBe("picking");
    expect(view.lines[1]!.tasks).toMatchObject([{ locationId: store.binA, quantity: 1 }]);
    await expectReconciled();
  });
});

describe("substitutions racing", () => {
  it("adds one line when two managers substitute the same shortage at once", async () => {
    const { orderId, shortageId } = await shortOrder();
    const replacement = await createProduct(ctx);
    await addStock(ctx, store, { productId: replacement, quantity: 10 });
    const results = await Promise.allSettled([1, 2, 3].map(() => substitute(orderId, shortageId, replacement, 2)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await lineCount(orderId)).toBe(2);
    const [balance] = await ctx.handle.db.select().from(inventoryBalances).where(eq(inventoryBalances.productId, replacement));
    expect(balance!.reserved).toBe(2);
    await expectReconciled();
  });

  it("never promises the substitute's stock twice when new orders want it too", async () => {
    for (let round = 0; round < 5; round++) {
      const { orderId, shortageId } = await shortOrder();
      const replacement = await createProduct(ctx);
      await addStock(ctx, store, { productId: replacement, quantity: 3 });
      const [substituted] = await Promise.allSettled([
        substitute(orderId, shortageId, replacement, 2),
        ...[1, 2].map(() =>
          ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId: replacement, quantity: 1 }] }),
        ),
      ]);
      const [balance] = await ctx.handle.db.select().from(inventoryBalances).where(eq(inventoryBalances.productId, replacement));
      expect(balance!.reserved).toBeLessThanOrEqual(balance!.onHand);
      if (substituted.status === "rejected") expect(substituted.reason.message).toMatch(/Not enough sellable stock/);
    }
    await expectReconciled();
  });
});

describe("substitution permissions", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("lets only store managers substitute", async () => {
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const { orderId, shortageId } = await shortOrder();
    const replacement = await createProduct(ctx);
    await addStock(ctx, store, { productId: replacement, quantity: 2 });
    await ctx.handle.db.update(products).set({ name: "Other brand" }).where(eq(products.id, replacement));
    const path = `/stores/${store.storeId}/orders/${orderId}/shortages/${shortageId}/resolve`;
    const body = { resolution: "substitute", substituteProductId: replacement, quantity: 2, reason: "Customer agreed" };

    expect((await server.request("POST", path, { token: picker, body, key: randomUUID() })).status).toBe(403);
    const bad = await server.request("POST", path, { token: manager, body: { ...body, quantity: 0 }, key: randomUUID() });
    expect(bad.status).toBe(422);
    const done = await server.request("POST", path, { token: manager, body, key: randomUUID() });
    expect(done.status).toBe(200);
    expect(done.body.lines[1]).toMatchObject({ productId: replacement, name: "Other brand", reservedQty: 2 });
  });
});
