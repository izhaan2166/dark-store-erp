import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { products } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createBatch, createContext, createProduct, createStore, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;
let other: TestStore;
let supplierId: string;

beforeAll(async () => {
  ctx = createContext(10);
  store = await createStore(ctx);
  other = await createStore(ctx);
  supplierId = (await ctx.purchasing.createSupplier(actor(store), { code: `SUP-${randomUUID().slice(0, 6)}`, name: "Fresh Farms" }))
    .supplierId;
});
afterAll(() => ctx.handle.close());

async function named(name: string, opts: { batchTracked?: boolean; costPaise?: number } = {}) {
  const productId = await createProduct(ctx, { batchTracked: opts.batchTracked });
  await ctx.handle.db
    .update(products)
    .set({ name, avgUnitCostPaise: opts.costPaise ?? null })
    .where(eq(products.id, productId));
  return productId;
}

describe("lists for the Store Manager's approvals", () => {
  it("lists receipts waiting for approval with the order, supplier, receiver and each line", async () => {
    const oil = await named("Oil 1L");
    const rice = await named("Rice 5kg");
    const po = await ctx.purchasing.createPurchaseOrder(actor(store), {
      supplierId,
      poNumber: `PO-${randomUUID().slice(0, 6)}`,
      lines: [
        { productId: oil, quantity: 100, unitCostPaise: 1000 },
        { productId: rice, quantity: 10, unitCostPaise: 1000 },
      ],
    });
    const pending = await ctx.receiving.recordReceipt(actor(store), {
      purchaseOrderId: po.purchaseOrderId,
      receivingLocationId: store.receiving,
      lines: [
        { productId: oil, acceptedQty: 50, damagedQty: 2 },
        { productId: rice, acceptedQty: 10 },
      ],
    });
    expect(pending.status).toBe("pending_approval");

    const list = await ctx.receiving.listReceipts(store.storeId, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      goodsReceiptId: pending.goodsReceiptId,
      status: "pending_approval",
      poNumber: po.poNumber,
      supplierName: "Fresh Farms",
      receivedByName: "Ops user",
      lines: [
        { productId: oil, name: "Oil 1L", expectedQty: 100, acceptedQty: 50, damagedQty: 2, rejectedQty: 0, needsApproval: true, lotCode: null },
        { productId: rice, name: "Rice 5kg", expectedQty: 10, acceptedQty: 10, needsApproval: false },
      ],
    });
    expect(await ctx.receiving.listReceipts(store.storeId, { status: "posted" })).toEqual([]);
    expect(await ctx.receiving.listReceipts(other.storeId, {})).toEqual([]);

    await ctx.receiving.approveReceipt(actor(store), pending.goodsReceiptId, "Supplier short-shipped, rest next week");
    expect(await ctx.receiving.listReceipts(store.storeId, {})).toEqual([]);
    expect((await ctx.receiving.listReceipts(store.storeId, { status: "posted" })).map((r) => r.goodsReceiptId)).toEqual([pending.goodsReceiptId]);
  });

  it("lists counts waiting for approval with the shelf, counter, differences and their value", async () => {
    const milk = await named("Milk 1L", { batchTracked: true, costPaise: 6000 });
    const batchId = await createBatch(ctx, milk, 20);
    await addStock(ctx, store, { productId: milk, quantity: 10, batchId });
    const count = await ctx.counts.submitCount(actor(store), { locationId: store.binA, lines: [{ productId: milk, batchId, countedQty: 4 }] });
    expect(count.status).toBe("pending_approval");

    const [listed, ...rest] = await ctx.counts.listCounts(store.storeId, {});
    expect(rest).toEqual([]);
    expect(listed).toMatchObject({
      stockCountId: count.stockCountId,
      locationCode: "A-01-01",
      countedByName: "Ops user",
      lines: [{ productId: milk, name: "Milk 1L", bookQty: 10, countedQty: 4, variance: -6, varianceValuePaise: -36000, needsApproval: true }],
    });
    expect(listed!.lines[0]!.lotCode).toMatch(/^LOT-/);
    await expect(ctx.counts.listCounts(store.storeId, { status: "lost" })).rejects.toThrow(/Invalid filter/);
  });

  it("names the product, lot, places and requester on stock requests", async () => {
    const curd = await named("Curd 400g", { batchTracked: true });
    const batchId = await createBatch(ctx, curd, 10);
    await addStock(ctx, store, { productId: curd, quantity: 3, batchId, locationId: store.quarantine, status: "quarantined" });
    const writeOff = await ctx.stockControl.requestWriteOff(actor(store), {
      productId: curd,
      batchId,
      locationId: store.quarantine,
      status: "quarantined",
      quantity: 1,
      reason: "Lid broken",
    });
    const release = await ctx.stockControl.requestRelease(actor(store), {
      productId: curd,
      batchId,
      fromLocationId: store.quarantine,
      toLocationId: store.binB,
      quantity: 2,
      reason: "Checked, seal intact",
    });
    const list = await ctx.stockControl.listRequests(store.storeId, {});
    expect(list.find((r) => r.id === writeOff.id)).toMatchObject({
      kind: "write_off",
      productName: "Curd 400g",
      fromLocationCode: "QUAR-1",
      toLocationCode: null,
      requestedByName: "Ops user",
      quantity: 1,
      reason: "Lid broken",
    });
    expect(list.find((r) => r.id === release.id)).toMatchObject({ kind: "release", fromLocationCode: "QUAR-1", toLocationCode: "B-01-01" });
    expect(list.find((r) => r.id === release.id)!.lotCode).toMatch(/^LOT-/);
  });
});

describe("approval lists over HTTP", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("lets managers read them and keeps receipts from pickers", async () => {
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const base = `/stores/${store.storeId}`;
    expect((await server.request("GET", `${base}/goods-receipts`, { token: picker })).status).toBe(403);
    for (const path of ["goods-receipts", "stock-counts", "stock-requests"]) {
      const res = await server.request("GET", `${base}/${path}`, { token: manager });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });
});
