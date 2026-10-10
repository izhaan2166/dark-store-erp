import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { products } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, createContext, createProduct, createStore, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;
let supplierId: string;

beforeAll(async () => {
  ctx = createContext(10);
  store = await createStore(ctx);
  supplierId = (await ctx.purchasing.createSupplier(actor(store), { code: `SUP-${randomUUID().slice(0, 6)}`, name: "Fresh Farms" }))
    .supplierId;
});
afterAll(() => ctx.handle.close());

async function named(name: string, batchTracked = false) {
  const productId = await createProduct(ctx, { batchTracked });
  await ctx.handle.db.update(products).set({ name }).where(eq(products.id, productId));
  return productId;
}

const purchaseOrder = (lines: { productId: string; quantity: number }[]) =>
  ctx.purchasing.createPurchaseOrder(actor(store), {
    supplierId,
    poNumber: `PO-${randomUUID().slice(0, 8)}`,
    lines: lines.map((l) => ({ ...l, unitCostPaise: 1000 })),
  });

describe("purchase orders for the receiving screen", () => {
  it("shows the supplier, product names and whether a line needs lot and expiry", async () => {
    const milk = await named("Milk 1L", true);
    const rice = await named("Rice 5kg");
    const po = await purchaseOrder([
      { productId: milk, quantity: 10 },
      { productId: rice, quantity: 4 },
    ]);
    expect(po).toMatchObject({
      supplierName: "Fresh Farms",
      pendingReceipts: 0,
      lines: [
        { productId: milk, name: "Milk 1L", batchTracked: true, orderedQty: 10, outstandingQty: 10 },
        { productId: rice, name: "Rice 5kg", batchTracked: false, orderedQty: 4, outstandingQty: 4 },
      ],
    });
    expect(po.lines[0]!.sku).toMatch(/^SKU-/);
  });

  it("lists open orders oldest first with what is still to come and receipts awaiting approval", async () => {
    const other = await createStore(ctx);
    const rice = await named("Rice 5kg");
    const oil = await named("Oil 1L");
    const first = await purchaseOrder([{ productId: rice, quantity: 10 }]);
    const second = await purchaseOrder([{ productId: oil, quantity: 100 }]);
    const done = await purchaseOrder([{ productId: rice, quantity: 2 }]);

    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: first.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId: rice, acceptedQty: 10 }],
    });
    // 50 of 100 is far outside tolerance, so it waits for a manager and counts as nothing received yet.
    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: second.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId: oil, acceptedQty: 50 }],
    });
    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: done.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId: rice, acceptedQty: 2 }],
    });

    const open = await ctx.purchasing.listPurchaseOrders(store.storeId, {});
    const ours = open.filter((p) => [first, second, done].some((po) => po.purchaseOrderId === p.purchaseOrderId));
    expect(ours).toMatchObject([
      { purchaseOrderId: second.purchaseOrderId, supplierName: "Fresh Farms", status: "open", lineCount: 1, orderedUnits: 100, outstandingUnits: 100, pendingReceipts: 1 },
    ]);
    expect((await ctx.purchasing.getPurchaseOrder(store.storeId, second.purchaseOrderId)).pendingReceipts).toBe(1);

    const received = await ctx.purchasing.listPurchaseOrders(store.storeId, { status: "received" });
    expect(received.map((p) => p.purchaseOrderId)).toEqual(
      expect.arrayContaining([first.purchaseOrderId, done.purchaseOrderId]),
    );
    expect(await ctx.purchasing.listPurchaseOrders(other.storeId, {})).toEqual([]);
    await expect(ctx.purchasing.listPurchaseOrders(store.storeId, { status: "lost" })).rejects.toThrow(/Invalid filter/);
  });
});

describe("purchase order list over HTTP", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("is open to receiving staff and closed to pickers", async () => {
    const receiver = (await signIn(ctx, server, [[store, "receiving_staff"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const path = `/stores/${store.storeId}/purchase-orders`;
    expect((await server.request("GET", path, { token: picker })).status).toBe(403);
    const res = await server.request("GET", path, { token: receiver });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("names the product on each stock row", async () => {
    const receiver = (await signIn(ctx, server, [[store, "receiving_staff"]])).token;
    const tea = await named("Tea 250g");
    const po = await purchaseOrder([{ productId: tea, quantity: 3 }]);
    await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [{ productId: tea, acceptedQty: 3 }],
    });
    const res = await server.request("GET", `/stores/${store.storeId}/inventory?status=receiving&productId=${tea}`, { token: receiver });
    expect(res.body.items).toMatchObject([{ productId: tea, name: "Tea 250g", locationCode: "RECV-1", status: "receiving", onHand: 3 }]);
  });
});
