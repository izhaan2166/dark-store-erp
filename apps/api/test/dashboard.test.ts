import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { batches, orders, productBarcodes, storeSettings } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createBatch, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;

beforeAll(() => {
  ctx = createContext(10);
});
afterAll(() => ctx.handle.close());

async function scannable(): Promise<{ productId: string; barcode: string }> {
  const productId = await createProduct(ctx);
  const barcode = `BC${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
  return { productId, barcode };
}

/** Takes a fresh order for `quantity` units through to handover. */
async function handOver(store: TestStore, productId: string, barcode: string, quantity: number) {
  const accepted = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity }] });
  const itemId = accepted.lines[0]!.orderItemId;
  await ctx.fulfilment.startPicking(actor(store), accepted.orderId);
  await ctx.fulfilment.pick(actor(store), accepted.orderId, { orderItemId: itemId, locationId: store.binA, barcode, quantity });
  await ctx.fulfilment.completePicking(actor(store), accepted.orderId);
  await ctx.fulfilment.pack(actor(store), accepted.orderId, { lines: [{ orderItemId: itemId, quantity }] });
  await ctx.fulfilment.handover(actor(store), accepted.orderId);
  return accepted.orderId;
}

describe("dashboard", () => {
  it("is all zeros for a new store", async () => {
    const store = await createStore(ctx);
    const view = await ctx.dashboard.summary(store.storeId);
    expect(view.kpis).toEqual({ handedOverToday: 0, medianFulfilmentMinutes: null, awaitingFulfilment: 0, outOfStock: 0, expiryAlerts: 0 });
    expect(Object.values(view.exceptions).every((n) => n === 0)).toBe(true);
    expect(view.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.expiryAlertDays).toBe(3);
  });

  it("counts orders handed over today and how long they took, and lists exactly those", async () => {
    const store = await createStore(ctx);
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 20 });
    const fast = await handOver(store, productId, barcode, 1);
    const slow = await handOver(store, productId, barcode, 2);
    const older = await handOver(store, productId, barcode, 1);
    await ctx.handle.db.execute(sql`UPDATE orders SET created_at = updated_at - interval '10 minutes' WHERE id = ${fast}`);
    await ctx.handle.db.execute(sql`UPDATE orders SET created_at = updated_at - interval '30 minutes' WHERE id = ${slow}`);
    await ctx.handle.db.execute(sql`UPDATE orders SET created_at = now() - interval '3 days', updated_at = now() - interval '2 days' WHERE id = ${older}`);
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] });

    const view = await ctx.dashboard.summary(store.storeId);
    expect(view.kpis.handedOverToday).toBe(2);
    expect(view.kpis.medianFulfilmentMinutes).toBe(20);
    expect(view.kpis.awaitingFulfilment).toBe(1);
    const rows = await ctx.dashboard.handedOverToday(store.storeId);
    expect(rows.map((r) => [r.orderId, r.minutes]).sort()).toEqual([[fast, 10], [slow, 30]].sort());
  });

  it("counts a product as out of stock when nothing is available to promise, and lists those first that customers wait for", async () => {
    const store = await createStore(ctx);
    const plenty = await createProduct(ctx);
    const reservedAway = await createProduct(ctx);
    const onlyBlocked = await createProduct(ctx);
    const retired = await createProduct(ctx);
    const neverStocked = await createProduct(ctx);
    await addStock(ctx, store, { productId: plenty, quantity: 5 });
    await addStock(ctx, store, { productId: reservedAway, quantity: 2 });
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId: reservedAway, quantity: 5 }] });
    await addStock(ctx, store, { productId: onlyBlocked, quantity: 3, locationId: store.quarantine, status: "quarantined" });
    await addStock(ctx, store, { productId: retired, quantity: 1, locationId: store.quarantine, status: "quarantined" });
    await ctx.handle.db.execute(sql`UPDATE products SET status = 'inactive' WHERE id = ${retired}`);

    const view = await ctx.dashboard.summary(store.storeId);
    const rows = await ctx.dashboard.outOfStock(store.storeId);
    expect(view.kpis.outOfStock).toBe(2);
    expect(rows.map((r) => [r.productId, r.openShortageUnits])).toEqual([
      [reservedAway, 3],
      [onlyBlocked, 0],
    ]);
    expect(rows.map((r) => r.productId)).not.toContain(neverStocked);
    expect(view.exceptions.openShortages).toBe(1);
  });

  it("raises expiry alerts for lots on sale or blocked within the store's alert window", async () => {
    const store = await createStore(ctx);
    await ctx.handle.db.update(storeSettings).set({ expiryAlertDays: 2 }).where(eq(storeSettings.storeId, store.storeId));
    const milk = await createProduct(ctx, { batchTracked: true });
    const soon = await createBatch(ctx, milk, 2);
    const later = await createBatch(ctx, milk, 3);
    const gone = await createBatch(ctx, milk, -1);
    await addStock(ctx, store, { productId: milk, batchId: soon, quantity: 4 });
    await addStock(ctx, store, { productId: milk, batchId: soon, quantity: 1, locationId: store.quarantine, status: "quarantined" });
    await addStock(ctx, store, { productId: milk, batchId: later, quantity: 6 });
    await addStock(ctx, store, { productId: milk, batchId: gone, quantity: 2, status: "expired" });
    await addStock(ctx, store, { productId: milk, batchId: gone, quantity: 1, locationId: store.quarantine, status: "damaged" });

    const view = await ctx.dashboard.summary(store.storeId);
    const rows = await ctx.dashboard.expiring(store.storeId);
    expect(view.kpis.expiryAlerts).toBe(2);
    expect(rows.map((r) => [r.batchId, r.status, r.onHand])).toEqual([
      [gone, "expired", 2],
      [soon, "available", 4],
      [soon, "quarantined", 1],
    ]);
    const [batch] = await ctx.handle.db.select().from(batches).where(eq(batches.id, soon));
    expect(rows[1]).toMatchObject({ lotCode: batch!.lotCode, expiryDate: batch!.expiryDate, locationCode: "A-01-01" });
  });

  it("counts what is waiting on a manager and stock waiting to be put away", async () => {
    const store = await createStore(ctx);
    const rice = await createProduct(ctx);
    await addStock(ctx, store, { productId: rice, quantity: 7, locationId: store.receiving, status: "receiving" });
    await addStock(ctx, store, { productId: rice, quantity: 3, locationId: store.quarantine, status: "damaged" });
    await ctx.stockControl.requestWriteOff(actor(store), {
      productId: rice,
      batchId: null,
      locationId: store.quarantine,
      status: "damaged",
      quantity: 3,
      reason: "Torn bags",
    });
    const accepted = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId: rice, quantity: 1 }] });
    await ctx.handle.db.update(orders).set({ status: "exception" }).where(eq(orders.id, accepted.orderId));

    const { exceptions, kpis } = await ctx.dashboard.summary(store.storeId);
    expect(exceptions).toMatchObject({ unitsAwaitingPutaway: 7, requestsAwaitingApproval: 1, problemOrders: 1, openShortages: 1 });
    expect(kpis.awaitingFulfilment).toBe(1);
  });
});

describe("dashboard over HTTP", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("is open to managers and auditors, not to pickers", async () => {
    const store = await createStore(ctx);
    const auditor = (await signIn(ctx, server, [[store, "auditor"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    for (const path of ["", "/handed-over", "/out-of-stock", "/expiring"]) {
      const url = `/stores/${store.storeId}/dashboard${path}`;
      expect((await server.request("GET", url, { token: picker })).status).toBe(403);
      expect((await server.request("GET", url, { token: auditor })).status).toBe(200);
    }
  });
});
