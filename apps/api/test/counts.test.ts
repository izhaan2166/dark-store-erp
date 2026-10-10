import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, inventoryBalances, inventoryMovements, productBarcodes, products } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countNeedsApproval, countPlan } from "../src/inventory/counts.service";
import { actor, addStock, createBatch, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(20);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

const thresholds = { qtyThreshold: 2, valueThresholdPaise: 100_000 };

async function costed(costPaise: number | null, opts: { batchTracked?: boolean } = {}) {
  const productId = await createProduct(ctx, opts);
  if (costPaise !== null) {
    await ctx.handle.db.update(products).set({ avgUnitCostPaise: costPaise }).where(eq(products.id, productId));
  }
  return productId;
}

async function held(productId: string, status: "available" | "quarantined", locationId = store.binA) {
  const rows = await ctx.handle.db
    .select({ onHand: inventoryBalances.onHand })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.locationId, locationId),
        eq(inventoryBalances.status, status),
      ),
    );
  return rows.reduce((n, r) => n + r.onHand, 0);
}

const count = (productId: string, countedQty: number, batchId: string | null = null) =>
  ctx.counts.submitCount(actor(store), { locationId: store.binA, lines: [{ productId, batchId, countedQty }] });

async function expectReconciled() {
  expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
}

describe("count approval rule", () => {
  it("allows up to 2 units and ₹1,000 either way", () => {
    expect(countNeedsApproval({ variance: -2, releasesBlocked: 0, unitCostPaise: 1000 }, thresholds)).toBe(false);
    expect(countNeedsApproval({ variance: 3, releasesBlocked: 0, unitCostPaise: 1000 }, thresholds)).toBe(true);
    expect(countNeedsApproval({ variance: -2, releasesBlocked: 0, unitCostPaise: 50_000 }, thresholds)).toBe(false);
    expect(countNeedsApproval({ variance: -2, releasesBlocked: 0, unitCostPaise: 50_001 }, thresholds)).toBe(true);
  });

  it("always asks when the product has no cost or blocked units go back on sale", () => {
    expect(countNeedsApproval({ variance: 1, releasesBlocked: 0, unitCostPaise: null }, thresholds)).toBe(true);
    expect(countNeedsApproval({ variance: 0, releasesBlocked: 0, unitCostPaise: null }, thresholds)).toBe(false);
    expect(countNeedsApproval({ variance: 0, releasesBlocked: 1, unitCostPaise: 10 }, thresholds)).toBe(true);
  });

  it("takes missing units out of blocked stock first", () => {
    expect(countPlan({ bookQty: 10, blockedQty: 2, countedQty: 7 })).toEqual({
      variance: -3,
      removeBlocked: 2,
      removeAvailable: 1,
      add: 0,
      releasesBlocked: 0,
    });
    expect(countPlan({ bookQty: 10, blockedQty: 2, countedQty: 10 })).toMatchObject({ releasesBlocked: 2, add: 0 });
    expect(countPlan({ bookQty: 10, blockedQty: 2, countedQty: 9 })).toMatchObject({ removeBlocked: 1, releasesBlocked: 1 });
  });
});

describe("stock counts", () => {
  it("posts a small difference at once as an adjustment", async () => {
    const productId = await costed(1000);
    await addStock(ctx, store, { productId, quantity: 10 });
    const result = await count(productId, 8);
    expect(result).toMatchObject({ status: "posted", lines: [{ bookQty: 10, countedQty: 8, variance: -2, varianceValuePaise: -2000 }] });
    expect(await held(productId, "available")).toBe(8);
    const movements = await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, result.stockCountId));
    expect(movements).toMatchObject([{ movementType: "adjustment", quantity: 2, fromStatus: "available" }]);
    await expectReconciled();
  });

  it("changes nothing when the count matches the book", async () => {
    const productId = await costed(null);
    await addStock(ctx, store, { productId, quantity: 4 });
    const result = await count(productId, 4);
    expect(result.status).toBe("posted");
    expect(await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, result.stockCountId))).toEqual(
      [],
    );
  });

  it("holds a large difference until a Store Manager approves it with a reason", async () => {
    const productId = await costed(1000);
    await addStock(ctx, store, { productId, quantity: 10 });
    const result = await count(productId, 13);
    expect(result.status).toBe("pending_approval");
    expect(await held(productId, "available")).toBe(10);

    await expect(ctx.counts.approveCount(actor(store), result.stockCountId, " ")).rejects.toThrow(/reason/);
    const approved = await ctx.counts.approveCount(actor(store), result.stockCountId, "Recounted twice, found a hidden case");
    expect(approved.status).toBe("posted");
    expect(await held(productId, "available")).toBe(13);
    const [audit] = await ctx.handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, result.stockCountId), eq(auditLogs.action, "stock_count.approve")));
    expect(audit!.after).toMatchObject({ reason: "Recounted twice, found a hidden case" });
    await expect(ctx.counts.approveCount(actor(store), result.stockCountId, "again")).rejects.toThrow(/not waiting/);
    await expectReconciled();
  });

  it("asks for approval on value alone, and for products with no cost", async () => {
    const pricey = await costed(150_000);
    await addStock(ctx, store, { productId: pricey, quantity: 5 });
    expect((await count(pricey, 4)).status).toBe("pending_approval");

    const uncosted = await costed(null);
    await addStock(ctx, store, { productId: uncosted, quantity: 5 });
    expect((await count(uncosted, 4)).status).toBe("pending_approval");
  });

  it("changes nothing when a count is rejected", async () => {
    const productId = await costed(1000);
    await addStock(ctx, store, { productId, quantity: 10 });
    const result = await count(productId, 1);
    const rejected = await ctx.counts.rejectCount(actor(store), result.stockCountId, "Counted the wrong bin");
    expect(rejected).toMatchObject({ status: "rejected", decisionReason: "Counted the wrong bin" });
    expect(await held(productId, "available")).toBe(10);
  });

  it("never adjusts away units that orders have reserved", async () => {
    const productId = await costed(1000);
    await addStock(ctx, store, { productId, quantity: 5 });
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 5 }] });
    await expect(count(productId, 3)).rejects.toThrow(/report a short pick/);
    expect(await held(productId, "available")).toBe(5);
    await expectReconciled();
  });

  it("requires a batch for batch-tracked products", async () => {
    const productId = await costed(1000, { batchTracked: true });
    const batchId = await createBatch(ctx, productId, 30);
    await addStock(ctx, store, { productId, quantity: 3, batchId });
    await expect(count(productId, 3)).rejects.toThrow(/per batch/);
    expect((await count(productId, 2, batchId)).status).toBe("posted");
  });
});

describe("counts racing with orders", () => {
  it("never removes reserved units, whichever transaction wins", async () => {
    for (let round = 0; round < 5; round++) {
      const productId = await costed(1000);
      await addStock(ctx, store, { productId, quantity: 4 });
      const results = await Promise.allSettled([
        count(productId, 2),
        ...[1, 2, 3].map(() =>
          ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
        ),
      ]);
      const [counted] = results;
      const reserved = (
        await ctx.handle.db
          .select({ reserved: inventoryBalances.reserved, onHand: inventoryBalances.onHand })
          .from(inventoryBalances)
          .where(and(eq(inventoryBalances.productId, productId), eq(inventoryBalances.status, "available")))
      )[0]!;
      expect(reserved.reserved).toBeLessThanOrEqual(reserved.onHand);
      // The count either went through (2 left) or was refused because orders got there first.
      if (counted.status === "fulfilled") expect(reserved.onHand).toBe(2);
      else expect(counted.reason.message).toMatch(/report a short pick/);
    }
    await expectReconciled();
  });
});

describe("counts after a short pick", () => {
  async function shortPicked(quantity: number) {
    const productId = await costed(1000);
    const barcode = `BC${randomUUID().slice(0, 10)}`;
    await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
    await addStock(ctx, store, { productId, quantity });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity }] });
    await ctx.fulfilment.startPicking(actor(store), order.orderId);
    await ctx.fulfilment.shortPick(actor(store), order.orderId, {
      orderItemId: order.lines[0]!.orderItemId,
      locationId: store.binA,
      quantity,
      reason: "Not on the shelf",
    });
    return productId;
  }

  it("writes blocked units off when the count confirms they are gone", async () => {
    const productId = await shortPicked(2);
    expect(await held(productId, "quarantined")).toBe(2);
    const result = await count(productId, 0);
    expect(result).toMatchObject({ status: "posted", lines: [{ bookQty: 2, blockedQty: 2, variance: -2 }] });
    expect(await held(productId, "quarantined")).toBe(0);
    expect(await held(productId, "available")).toBe(0);
    await expectReconciled();
  });

  it("puts found units back on sale only after a Store Manager approves", async () => {
    const productId = await shortPicked(2);
    const result = await count(productId, 2);
    expect(result.status).toBe("pending_approval");
    await ctx.counts.approveCount(actor(store), result.stockCountId, "Found behind the next bin");
    expect(await held(productId, "quarantined")).toBe(0);
    expect(await held(productId, "available")).toBe(2);
    const next = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] });
    expect(next.fullyReserved).toBe(true);
    await expectReconciled();
  });
});

describe("count permissions", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("lets inventory managers count and only store managers approve", async () => {
    const inventory = (await signIn(ctx, server, [[store, "inventory_manager"]])).token;
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const productId = await costed(1000);
    await addStock(ctx, store, { productId, quantity: 10 });
    const base = `/stores/${store.storeId}/stock-counts`;
    const body = { locationId: store.binA, lines: [{ productId, countedQty: 20 }] };

    expect((await server.request("POST", base, { token: picker, body, key: randomUUID() })).status).toBe(403);
    const submitted = await server.request("POST", base, { token: inventory, body, key: randomUUID() });
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("pending_approval");
    const path = `${base}/${submitted.body.stockCountId}`;
    expect((await server.request("POST", `${path}/approve`, { token: inventory, body: { reason: "ok" }, key: randomUUID() })).status).toBe(403);
    const approved = await server.request("POST", `${path}/approve`, { token: manager, body: { reason: "Delivery was put away unrecorded" }, key: randomUUID() });
    expect(approved.status).toBe(200);
    expect((await server.request("GET", path, { token: picker })).body.status).toBe("posted");
  });
});
