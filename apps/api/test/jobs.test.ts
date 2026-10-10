import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  batches,
  inventoryBalances,
  inventoryMovements,
  orderItems,
  orderItemShortages,
  outboxEvents,
  productBarcodes,
  SYSTEM_USER_ID,
} from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

async function expectReconciled(s: TestStore = store) {
  expect(await ctx.reconciliation.run(s.storeId)).toMatchObject({ ok: true });
}

/** An order for more than is in stock, so it opens a reservation shortage. */
async function shortOrder(s: TestStore = store) {
  const productId = await createProduct(ctx);
  await addStock(ctx, s, { productId, quantity: 1 });
  const order = await ctx.orders.acceptOrder(actor(s), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
  const [shortage] = await ctx.handle.db
    .select()
    .from(orderItemShortages)
    .where(eq(orderItemShortages.orderItemId, order.lines[0]!.orderItemId));
  return { order, shortageId: shortage!.id };
}

const age = (shortageId: string, minutes: number) =>
  ctx.handle.db
    .update(orderItemShortages)
    .set({ createdAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(orderItemShortages.id, shortageId));

const shortage = async (id: string) =>
  (await ctx.handle.db.select().from(orderItemShortages).where(eq(orderItemShortages.id, id)))[0]!;

describe("shortage escalation", () => {
  it("escalates a shortage still open after 15 minutes, once, without cancelling", async () => {
    const { order, shortageId } = await shortOrder();
    await age(shortageId, 14);
    expect(await ctx.jobs.escalateShortages(store.storeId)).toBe(0);

    await age(shortageId, 16);
    expect(await ctx.jobs.escalateShortages(store.storeId)).toBe(1);
    expect((await shortage(shortageId)).escalatedAt).not.toBeNull();
    expect((await ctx.orders.getOrder(store.storeId, order.orderId)).status).toBe("accepted");
    const events = await ctx.handle.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, "order.shortage_escalated"), sql`${outboxEvents.payload}->>'orderId' = ${order.orderId}`));
    expect(events).toHaveLength(1);
    const [audit] = await ctx.handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, order.orderId), eq(auditLogs.action, "order.shortage_escalate")));
    expect(audit!.actorUserId).toBe(SYSTEM_USER_ID);

    expect(await ctx.jobs.escalateShortages(store.storeId)).toBe(0);
  });

  it("uses the store's own escalation time", async () => {
    const patient = await createStore(ctx, { shortageEscalationMinutes: 60 });
    const { shortageId } = await shortOrder(patient);
    await age(shortageId, 30);
    expect(await ctx.jobs.escalateShortages(patient.storeId)).toBe(0);
    await age(shortageId, 61);
    expect(await ctx.jobs.escalateShortages(patient.storeId)).toBe(1);
  });

  it("leaves resolved shortages alone", async () => {
    const { order, shortageId } = await shortOrder();
    await ctx.fulfilment.resolveShortage(actor(store), order.orderId, shortageId, { resolution: "remove", reason: "Customer agreed" });
    await age(shortageId, 30);
    expect(await ctx.jobs.escalateShortages(store.storeId)).toBe(0);
    expect((await shortage(shortageId)).escalatedAt).toBeNull();
  });

  it("escalates once when several workers run at the same time", async () => {
    const { order, shortageId } = await shortOrder();
    await age(shortageId, 20);
    // Hold the order so every worker has found the shortage before any can act on it.
    const holder = await ctx.handle.pool.connect();
    let runs: Promise<number[]>;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [order.orderId]);
      runs = Promise.all([1, 2, 3].map(() => ctx.jobs.escalateShortages(store.storeId)));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }
    expect((await runs).reduce((a, b) => a + b, 0)).toBe(1);
    const events = await ctx.handle.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, "order.shortage_escalated"), sql`${outboxEvents.payload}->>'orderId' = ${order.orderId}`));
    expect(events).toHaveLength(1);
  });

  it("puts escalated shortages at the top of the manager's queue", async () => {
    const queueStore = await createStore(ctx);
    const older = await shortOrder(queueStore);
    const escalated = await shortOrder(queueStore);
    await age(older.shortageId, 5);
    await age(escalated.shortageId, 20);
    await ctx.jobs.escalateShortages(queueStore.storeId);
    const queue = await ctx.fulfilment.openShortages(queueStore.storeId);
    expect(queue.map((s) => s.shortageId)).toEqual([escalated.shortageId, older.shortageId]);
    expect(queue[0]).toMatchObject({ orderId: escalated.order.orderId, source: "reservation", quantity: 2, name: "Test product" });
    expect(queue[0]!.escalatedAt).not.toBeNull();
    expect(queue[1]!.escalatedAt).toBeNull();
  });
});

async function held(productId: string, locationId: string, status: "available" | "expired") {
  const rows = await ctx.handle.db
    .select({ onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.productId, productId), eq(inventoryBalances.locationId, locationId), eq(inventoryBalances.status, status)));
  return rows.reduce((n, r) => n + r.onHand, 0);
}

const expire = (batchId: string) =>
  ctx.handle.db.update(batches).set({ expiryDate: sql`current_date - 1` }).where(eq(batches.id, batchId));

describe("expiry sweep", () => {
  it("takes free expired units off sale and leaves good batches alone", async () => {
    const sweepStore = await createStore(ctx);
    const productId = await createProduct(ctx, { batchTracked: true });
    const old = await createBatch(ctx, productId, 0);
    const fresh = await createBatch(ctx, productId, 30);
    await addStock(ctx, sweepStore, { productId, batchId: old, quantity: 4 });
    await addStock(ctx, sweepStore, { productId, batchId: fresh, quantity: 2 });

    expect(await ctx.jobs.sweepExpired(sweepStore.storeId)).toEqual({ releasedUnits: 0, expiredUnits: 4 });
    expect(await held(productId, sweepStore.binA, "expired")).toBe(4);
    expect(await held(productId, sweepStore.binA, "available")).toBe(2);
    const [movement] = await ctx.handle.db
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.batchId, old), eq(inventoryMovements.sourceType, "expiry_sweep")));
    expect(movement).toMatchObject({ movementType: "status_change", toStatus: "expired", actorUserId: SYSTEM_USER_ID });

    expect(await ctx.jobs.sweepExpired(sweepStore.storeId)).toEqual({ releasedUnits: 0, expiredUnits: 0 });
    await expectReconciled(sweepStore);
  });

  it("releases expired units reserved by an order and opens a shortage for them", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const batchId = await createBatch(ctx, productId, 5);
    await addStock(ctx, store, { productId, batchId, quantity: 3 });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] });
    await expire(batchId);

    expect(await ctx.jobs.sweepExpired(store.storeId)).toEqual({ releasedUnits: 2, expiredUnits: 3 });
    const view = await ctx.fulfilment.view(store.storeId, order.orderId);
    expect(view.status).toBe("accepted");
    expect(view.lines[0]).toMatchObject({ reservedQty: 0, openShortageQty: 2, tasks: [] });
    expect(view.openShortages).toMatchObject([{ source: "expired", quantity: 2 }]);
    expect(await held(productId, store.binA, "expired")).toBe(3);
    await expectReconciled();
  });

  it("leaves units already picked for packing to the packer", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const barcode = `BC${randomUUID().slice(0, 10)}`;
    await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
    const batchId = await createBatch(ctx, productId, 5);
    await addStock(ctx, store, { productId, batchId, quantity: 2 });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] });
    const orderItemId = order.lines[0]!.orderItemId;
    await ctx.fulfilment.startPicking(actor(store), order.orderId);
    await ctx.fulfilment.pick(actor(store), order.orderId, { orderItemId, locationId: store.binA, barcode, quantity: 1 });
    await expire(batchId);

    expect(await ctx.jobs.sweepExpired(store.storeId)).toEqual({ releasedUnits: 1, expiredUnits: 1 });
    expect(await held(productId, store.packing, "available")).toBe(1);
    const [item] = await ctx.handle.db.select().from(orderItems).where(eq(orderItems.id, orderItemId));
    expect(item).toMatchObject({ pickedQty: 1, reservedQty: 0 });
    await expectReconciled();
  });

  it("waits for a picker who is working on the order", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const batchId = await createBatch(ctx, productId, 5);
    await addStock(ctx, store, { productId, batchId, quantity: 1 });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] });
    await expire(batchId);

    const picker = await ctx.handle.pool.connect();
    try {
      await picker.query("BEGIN");
      await picker.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [order.orderId]);
      let settled = false;
      const sweep = ctx.jobs.sweepExpired(store.storeId).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await picker.query("COMMIT");
      expect(await sweep).toEqual({ releasedUnits: 1, expiredUnits: 1 });
    } finally {
      picker.release();
    }
  });

  it("never loses a unit when pickers race the sweep", async () => {
    for (let round = 0; round < 10; round++) {
      const productId = await createProduct(ctx, { batchTracked: true });
      const barcode = `BC${randomUUID().slice(0, 10)}`;
      await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
      const batchId = await createBatch(ctx, productId, 5);
      await addStock(ctx, store, { productId, batchId, quantity: 3 });
      const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
      const orderItemId = order.lines[0]!.orderItemId;
      await ctx.fulfilment.startPicking(actor(store), order.orderId);
      await expire(batchId);

      const results = await Promise.allSettled([
        ...[1, 2].map(() =>
          ctx.fulfilment.pick(actor(store), order.orderId, { orderItemId, locationId: store.binA, barcode, quantity: 1 }),
        ),
        ctx.jobs.sweepExpired(store.storeId),
      ]);
      // A pick may lose to the sweep, but the sweep itself never fails.
      expect(results[2]!.status).toBe("fulfilled");
      const view = await ctx.fulfilment.view(store.storeId, order.orderId);
      const line = view.lines[0]!;
      expect(line.pickedQty + line.openShortageQty).toBe(3);
      expect(line.reservedQty).toBe(0);
      expect(await held(productId, store.packing, "available")).toBe(line.pickedQty);
      expect(await held(productId, store.binA, "expired")).toBe(3 - line.pickedQty);
    }
    await expectReconciled();
  });
});

describe("shortage queue permissions", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("shows the queue to anyone who can see orders", async () => {
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const receiving = (await signIn(ctx, server, [[store, "receiving_staff"]])).token;
    const { shortageId } = await shortOrder();
    const path = `/stores/${store.storeId}/shortages`;
    const queue = await server.request("GET", path, { token: manager });
    expect(queue.status).toBe(200);
    expect(queue.body.map((s: { shortageId: string }) => s.shortageId)).toContain(shortageId);
    expect((await server.request("GET", path, { token: receiving })).status).toBe(403);
  });
});
