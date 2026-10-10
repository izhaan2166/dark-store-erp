import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, inventoryBalances, inventoryMovements, productBarcodes } from "@dse/db";
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

type Status = "available" | "quarantined" | "damaged" | "expired";

async function held(productId: string, locationId: string, status: Status) {
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

const quarantine = (productId: string, quantity: number, key?: string) =>
  ctx.stockControl.quarantine(actor(store, key), {
    productId,
    fromLocationId: store.binA,
    toLocationId: store.quarantine,
    quantity,
    reason: "Dented cans",
  });

const release = (productId: string, quantity: number, batchId: string | null = null) =>
  ctx.stockControl.requestRelease(actor(store), {
    productId,
    batchId,
    fromLocationId: store.quarantine,
    toLocationId: store.binA,
    quantity,
    reason: "Checked, packaging is fine",
  });

const writeOff = (productId: string, quantity: number, status: Status = "available", locationId = store.binA) =>
  ctx.stockControl.requestWriteOff(actor(store), { productId, locationId, status, quantity, reason: "Crushed in transit" });

const approve = (requestId: string, reason = "Seen it myself") => ctx.stockControl.approve(actor(store), requestId, { reason });

async function expectReconciled() {
  expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
}

describe("quarantine", () => {
  it("blocks free units at once and records who did it and why", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const { movementId } = await quarantine(productId, 2);
    expect(await held(productId, store.binA, "available")).toBe(3);
    expect(await held(productId, store.quarantine, "quarantined")).toBe(2);
    const [movement] = await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.id, movementId));
    expect(movement).toMatchObject({ movementType: "status_change", reason: "Dented cans", actorUserId: store.userId });
    const [audit] = await ctx.handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "stock.quarantine"), eq(auditLogs.entityId, String(movementId))));
    expect(audit!.after).toMatchObject({ quantity: 2, reason: "Dented cans" });
    await expectReconciled();
  });

  it("moves stock once when the same request is sent twice", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const key = randomUUID();
    const first = await quarantine(productId, 2, key);
    expect(await quarantine(productId, 2, key)).toEqual(first);
    expect(await held(productId, store.quarantine, "quarantined")).toBe(2);
  });

  it("leaves units that orders have reserved alone", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
    await expect(quarantine(productId, 3)).rejects.toThrow(/short-picked first/);
    await quarantine(productId, 2);
    expect(await held(productId, store.binA, "available")).toBe(3);
    await expectReconciled();
  });

  it("only moves stock into a quarantine area, with a reason", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const request = { productId, fromLocationId: store.binA, quantity: 1, reason: "Dented" };
    await expect(ctx.stockControl.quarantine(actor(store), { ...request, toLocationId: store.binB })).rejects.toThrow(
      /active quarantine location/,
    );
    await expect(
      ctx.stockControl.quarantine(actor(store), { ...request, toLocationId: store.quarantine, reason: "  " }),
    ).rejects.toThrow(/Invalid quarantine/);
  });
});

describe("quarantine release", () => {
  it("waits for a Store Manager, then puts the units back on sale", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 4 });
    await quarantine(productId, 4);
    const request = await release(productId, 3);
    expect(request.status).toBe("pending_approval");
    expect(await held(productId, store.binA, "available")).toBe(0);
    expect((await ctx.stockControl.listRequests(store.storeId, {})).map((r) => r.id)).toContain(request.id);

    await expect(ctx.stockControl.approve(actor(store), request.id, {})).rejects.toThrow(/reason/);
    const approved = await approve(request.id, "Inspected every can");
    expect(approved).toMatchObject({ status: "approved", decidedBy: store.userId, decisionReason: "Inspected every can" });
    expect(await held(productId, store.binA, "available")).toBe(3);
    expect(await held(productId, store.quarantine, "quarantined")).toBe(1);
    await expect(approve(request.id)).rejects.toThrow(/not waiting/);

    const [audit] = await ctx.handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "stock_request.approve"), eq(auditLogs.entityId, request.id)));
    expect(audit!.after).toMatchObject({ kind: "release", reason: "Inspected every can" });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
    expect(order.fullyReserved).toBe(true);
    await expectReconciled();
  });

  it("refuses to put an expired batch back on sale", async () => {
    const productId = await createProduct(ctx, { batchTracked: true });
    const batchId = await createBatch(ctx, productId, 0);
    await addStock(ctx, store, { productId, batchId, quantity: 2, locationId: store.quarantine, status: "quarantined" });
    const request = await release(productId, 2, batchId);
    await expect(approve(request.id)).rejects.toThrow(/expired/);
    expect((await ctx.stockControl.getRequest(store.storeId, request.id)).status).toBe("pending_approval");
    expect(await held(productId, store.quarantine, "quarantined")).toBe(2);
  });

  it("refuses a request for more than is blocked there", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 2 });
    await quarantine(productId, 1);
    await expect(release(productId, 2)).rejects.toThrow(/Only 1 unreserved/);
  });

  it("puts short-picked units back on sale in the same bin", async () => {
    const productId = await createProduct(ctx);
    await ctx.handle.db.insert(productBarcodes).values({ barcode: `BC${randomUUID().slice(0, 10)}`, productId });
    await addStock(ctx, store, { productId, quantity: 2 });
    const order = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] });
    await ctx.fulfilment.startPicking(actor(store), order.orderId);
    await ctx.fulfilment.shortPick(actor(store), order.orderId, {
      orderItemId: order.lines[0]!.orderItemId,
      locationId: store.binA,
      quantity: 2,
      reason: "Not on the shelf",
    });
    const request = await ctx.stockControl.requestRelease(actor(store), {
      productId,
      fromLocationId: store.binA,
      toLocationId: store.binA,
      quantity: 2,
      reason: "Found behind the next bin",
    });
    await approve(request.id);
    expect(await held(productId, store.binA, "quarantined")).toBe(0);
    expect(await held(productId, store.binA, "available")).toBe(2);
    await expectReconciled();
  });
});

describe("write-offs", () => {
  it("removes stock only after a Store Manager approves", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 3, locationId: store.quarantine, status: "damaged" });
    const request = await writeOff(productId, 2, "damaged", store.quarantine);
    expect(await held(productId, store.quarantine, "damaged")).toBe(3);
    await approve(request.id, "Photos checked");
    expect(await held(productId, store.quarantine, "damaged")).toBe(1);
    const movements = await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, request.id));
    expect(movements).toMatchObject([{ movementType: "write_off", quantity: 2, fromStatus: "damaged", toLocationId: null }]);
    await expectReconciled();
  });

  it("changes nothing when rejected", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 3 });
    const request = await writeOff(productId, 3);
    const rejected = await ctx.stockControl.reject(actor(store), request.id, { reason: "Count it first" });
    expect(rejected).toMatchObject({ status: "rejected", decisionReason: "Count it first" });
    expect(await held(productId, store.binA, "available")).toBe(3);
    await expect(approve(request.id)).rejects.toThrow(/not waiting/);
  });

  it("will not write off units that orders reserved after the request", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const request = await writeOff(productId, 5);
    await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 3 }] });
    await expect(approve(request.id)).rejects.toThrow(/short-picked first/);
    expect((await ctx.stockControl.getRequest(store.storeId, request.id)).status).toBe("pending_approval");
    expect(await held(productId, store.binA, "available")).toBe(5);
    await expectReconciled();
  });
});

describe("approvals racing", () => {
  it("writes stock off once when two managers approve at the same time", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 6 });
    const request = await writeOff(productId, 2);
    const results = await Promise.allSettled([approve(request.id), approve(request.id), approve(request.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await held(productId, store.binA, "available")).toBe(4);
    await expectReconciled();
  });

  it("never writes off reserved units, whichever transaction wins", async () => {
    for (let round = 0; round < 5; round++) {
      const productId = await createProduct(ctx);
      await addStock(ctx, store, { productId, quantity: 4 });
      const request = await writeOff(productId, 2);
      const [approval] = await Promise.allSettled([
        approve(request.id),
        ...[1, 2, 3].map(() =>
          ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
        ),
      ]);
      const [balance] = await ctx.handle.db
        .select({ onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved })
        .from(inventoryBalances)
        .where(and(eq(inventoryBalances.productId, productId), eq(inventoryBalances.status, "available")));
      expect(balance!.reserved).toBeLessThanOrEqual(balance!.onHand);
      if (approval.status === "fulfilled") expect(balance!.onHand).toBe(2);
      else expect(approval.reason.message).toMatch(/short-picked first/);
    }
    await expectReconciled();
  });
});

describe("stock control permissions", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("lets inventory managers block and ask, and only store managers decide", async () => {
    const inventory = (await signIn(ctx, server, [[store, "inventory_manager"]])).token;
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const base = `/stores/${store.storeId}`;
    const hold = { productId, fromLocationId: store.binA, toLocationId: store.quarantine, quantity: 2, reason: "Leaking" };

    expect((await server.request("POST", `${base}/quarantines`, { token: picker, body: hold, key: randomUUID() })).status).toBe(403);
    expect((await server.request("POST", `${base}/quarantines`, { token: inventory, body: hold, key: randomUUID() })).status).toBe(201);

    const asked = await server.request("POST", `${base}/stock-requests/write-off`, {
      token: inventory,
      body: { productId, locationId: store.quarantine, status: "quarantined", quantity: 2, reason: "Leaking" },
      key: randomUUID(),
    });
    expect(asked.status).toBe(201);
    const path = `${base}/stock-requests/${asked.body.id}`;
    expect((await server.request("POST", `${path}/approve`, { token: inventory, body: { reason: "ok" }, key: randomUUID() })).status).toBe(403);
    const approved = await server.request("POST", `${path}/approve`, { token: manager, body: { reason: "Binned" }, key: randomUUID() });
    expect(approved.status).toBe(200);
    expect((await server.request("GET", path, { token: picker })).body.status).toBe("approved");
    const queue = await server.request("GET", `${base}/stock-requests?status=approved`, { token: inventory });
    expect(queue.body.map((r: { id: string }) => r.id)).toContain(asked.body.id);
    expect((await server.request("GET", `${base}/stock-requests/not-a-uuid`, { token: picker })).status).toBe(404);
  });
});
