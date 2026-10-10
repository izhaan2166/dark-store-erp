import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { inventoryBalances, inventoryMovements, productBarcodes, stockReservations } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(40);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

/** A product with a barcode, so it can be scanned. */
async function scannable(opts: { batchTracked?: boolean } = {}): Promise<{ productId: string; barcode: string }> {
  const productId = await createProduct(ctx, opts);
  const barcode = `BC${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await ctx.handle.db.insert(productBarcodes).values({ barcode, productId });
  return { productId, barcode };
}

async function order(s: TestStore, lines: { productId: string; quantity: number }[]) {
  return ctx.orders.acceptOrder(actor(s), { externalRef: orderRef(), lines });
}

async function onHand(s: TestStore, productId: string, locationId: string, status = "available") {
  const rows = await ctx.handle.db
    .select({ onHand: inventoryBalances.onHand })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.storeId, s.storeId),
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.locationId, locationId),
        eq(inventoryBalances.status, status as "available"),
      ),
    );
  return rows.reduce((n, r) => n + r.onHand, 0);
}

async function expectReconciled(s: TestStore = store) {
  expect(await ctx.reconciliation.run(s.storeId)).toMatchObject({ ok: true });
}

const f = () => ctx.fulfilment;

describe("picking, packing and handover", () => {
  it("takes an order from accepted to handed over", async () => {
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 10 });
    const accepted = await order(store, [{ productId, quantity: 4 }]);
    const orderId = accepted.orderId;
    const itemId = accepted.lines[0]!.orderItemId;

    const picking = await f().startPicking(actor(store), orderId);
    expect(picking.status).toBe("picking");
    expect(picking.lines[0]!.tasks).toMatchObject([{ locationId: store.binA, locationCode: "A-01-01", quantity: 4 }]);

    await expect(
      f().pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode: "NOT-THIS-ONE", quantity: 1 }),
    ).rejects.toMatchObject({ code: "wrong_item" });

    await f().pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode, quantity: 3 });
    const afterPicks = await f().pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode, quantity: 1 });
    expect(afterPicks.lines[0]).toMatchObject({ reservedQty: 0, pickedQty: 4, tasks: [] });
    expect(await onHand(store, productId, store.binA)).toBe(6);
    expect(await onHand(store, productId, store.packing)).toBe(4);
    await expectReconciled();

    await f().completePicking(actor(store), orderId);
    const packed = await f().pack(actor(store), orderId, { lines: [{ orderItemId: itemId, quantity: 4 }] });
    expect(packed.status).toBe("ready_for_handover");
    expect(packed.lines[0]!.fulfilledQty).toBe(4);

    const handed = await f().handover(actor(store), orderId);
    expect(handed.status).toBe("handed_over");
    expect(await onHand(store, productId, store.packing)).toBe(0);
    expect(await onHand(store, productId, store.binA)).toBe(6);

    const movements = await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, orderId));
    expect(movements.map((m) => m.movementType).sort()).toEqual(["handover", "pick", "pick"]);
    const [reservation] = await ctx.handle.db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
    expect(reservation!.status).toBe("closed");
    await expectReconciled();
  });

  it("lists picks bin by bin, earliest expiry first, and refuses more than is reserved in a bin", async () => {
    const { productId, barcode } = await scannable({ batchTracked: true });
    const later = await createBatch(ctx, productId, 60);
    const sooner = await createBatch(ctx, productId, 20);
    await addStock(ctx, store, { productId, quantity: 3, batchId: later, locationId: store.binA });
    await addStock(ctx, store, { productId, quantity: 2, batchId: sooner, locationId: store.binB });
    const accepted = await order(store, [{ productId, quantity: 4 }]);
    const view = await f().startPicking(actor(store), accepted.orderId);

    expect(view.lines[0]!.tasks.map((t) => [t.locationCode, t.batchId, t.quantity])).toEqual([
      ["A-01-01", later, 2],
      ["B-01-01", sooner, 2],
    ]);
    await expect(
      f().pick(actor(store), accepted.orderId, {
        orderItemId: accepted.lines[0]!.orderItemId,
        locationId: store.binB,
        barcode,
        quantity: 3,
      }),
    ).rejects.toThrow(/Only 2 of this item are reserved in this bin/);
  });

  it("blocks each step until the one before it is done", async () => {
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 5 });
    const accepted = await order(store, [{ productId, quantity: 2 }]);
    const orderId = accepted.orderId;
    const itemId = accepted.lines[0]!.orderItemId;
    const pick = { orderItemId: itemId, locationId: store.binA, barcode, quantity: 2 };

    await expect(f().pick(actor(store), orderId, pick)).rejects.toThrow(/Start picking/);
    await expect(f().pack(actor(store), orderId, { lines: [{ orderItemId: itemId, quantity: 2 }] })).rejects.toThrow(
      /Finish picking/,
    );
    await f().startPicking(actor(store), orderId);
    await expect(f().completePicking(actor(store), orderId)).rejects.toMatchObject({ code: "fulfilment_blocked" });
    await expect(f().handover(actor(store), orderId)).rejects.toThrow(/Pack this order first/);

    await f().pick(actor(store), orderId, pick);
    await expect(ctx.orders.cancelOrder(actor(store), orderId, "Changed mind")).rejects.toThrow();
  });

  it("refuses to pack when the packer's count differs from what was picked", async () => {
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 5 });
    const accepted = await order(store, [{ productId, quantity: 3 }]);
    const itemId = accepted.lines[0]!.orderItemId;
    await f().startPicking(actor(store), accepted.orderId);
    await f().pick(actor(store), accepted.orderId, { orderItemId: itemId, locationId: store.binA, barcode, quantity: 3 });
    await f().completePicking(actor(store), accepted.orderId);

    const err = await f()
      .pack(actor(store), accepted.orderId, { lines: [{ orderItemId: itemId, quantity: 2 }] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "fulfilment_blocked" });
    expect(err.details.mismatches).toMatchObject([{ picked: 3, counted: 2 }]);
    expect((await f().view(store.storeId, accepted.orderId)).status).toBe("packing");
  });
});

describe("short picks and shortages", () => {
  it("blocks missing units, holds packing until a manager decides, then ships what was found", async () => {
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 5 });
    const accepted = await order(store, [{ productId, quantity: 5 }]);
    const orderId = accepted.orderId;
    const itemId = accepted.lines[0]!.orderItemId;
    await f().startPicking(actor(store), orderId);
    await f().pick(actor(store), orderId, { orderItemId: itemId, locationId: store.binA, barcode, quantity: 3 });

    const short = await f().shortPick(actor(store), orderId, {
      orderItemId: itemId,
      locationId: store.binA,
      quantity: 2,
      reason: "Bin empty",
    });
    expect(short.lines[0]).toMatchObject({ reservedQty: 0, pickedQty: 3, openShortageQty: 2 });
    expect(short.openShortages).toMatchObject([{ source: "short_pick", quantity: 2 }]);
    // The missing units are blocked in the bin, so no other order is promised them.
    expect(await onHand(store, productId, store.binA, "quarantined")).toBe(2);
    expect(await onHand(store, productId, store.binA, "available")).toBe(0);
    const next = await order(store, [{ productId, quantity: 1 }]);
    expect(next.lines[0]!.reservedQty).toBe(0);
    await expectReconciled();

    // Picking can finish; packing cannot until the shortage is settled.
    await f().completePicking(actor(store), orderId);
    await expect(f().pack(actor(store), orderId, { lines: [{ orderItemId: itemId, quantity: 3 }] })).rejects.toThrow(
      /Resolve every shortage/,
    );

    await expect(
      f().resolveShortage(actor(store), orderId, short.openShortages[0]!.shortageId, { resolution: "reallocate", reason: "Try again" }),
    ).rejects.toMatchObject({ code: "insufficient_stock" });

    const resolved = await f().resolveShortage(actor(store), orderId, short.openShortages[0]!.shortageId, {
      resolution: "remove",
      reason: "Customer accepts 3",
    });
    expect(resolved.openShortages).toEqual([]);
    const packed = await f().pack(actor(store), orderId, { lines: [{ orderItemId: itemId, quantity: 3 }] });
    expect(packed.lines[0]).toMatchObject({ requestedQty: 5, fulfilledQty: 3 });
    await f().handover(actor(store), orderId);
    await expectReconciled();
  });

  it("reserves the shortfall from another bin and sends a packed order back to picking", async () => {
    const s = await createStore(ctx);
    const { productId, barcode } = await scannable();
    await addStock(ctx, s, { productId, quantity: 2, locationId: s.binA });
    const accepted = await order(s, [{ productId, quantity: 2 }]);
    const orderId = accepted.orderId;
    const itemId = accepted.lines[0]!.orderItemId;
    await f().startPicking(actor(s), orderId);
    await f().pick(actor(s), orderId, { orderItemId: itemId, locationId: s.binA, barcode, quantity: 1 });
    const short = await f().shortPick(actor(s), orderId, { orderItemId: itemId, locationId: s.binA, quantity: 1, reason: "Damaged, binned" });
    await f().completePicking(actor(s), orderId);

    // New stock arrives in another bin.
    await addStock(ctx, s, { productId, quantity: 4, locationId: s.binB });
    const reallocated = await f().resolveShortage(actor(s), orderId, short.openShortages[0]!.shortageId, {
      resolution: "reallocate",
      reason: "Restocked",
    });
    expect(reallocated.status).toBe("picking");
    expect(reallocated.lines[0]!.tasks).toMatchObject([{ locationId: s.binB, quantity: 1 }]);

    await f().pick(actor(s), orderId, { orderItemId: itemId, locationId: s.binB, barcode, quantity: 1 });
    await f().completePicking(actor(s), orderId);
    const packed = await f().pack(actor(s), orderId, { lines: [{ orderItemId: itemId, quantity: 2 }] });
    expect(packed.lines[0]!.fulfilledQty).toBe(2);
    await f().handover(actor(s), orderId);
    await expectReconciled(s);
  });
});

describe("concurrent fulfilment", () => {
  it("never picks the same reserved units twice", async () => {
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 4 });
    const accepted = await order(store, [{ productId, quantity: 4 }]);
    await f().startPicking(actor(store), accepted.orderId);
    const pick = { orderItemId: accepted.lines[0]!.orderItemId, locationId: store.binA, barcode, quantity: 2 };

    const results = await Promise.allSettled([1, 2, 3, 4].map(() => f().pick(actor(store), accepted.orderId, pick)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    // The losers are told cleanly that nothing is left, not hit by a constraint error.
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect(r.reason.message).toMatch(/Only 0 of this item are reserved in this bin/);
    }
    const view = await f().view(store.storeId, accepted.orderId);
    expect(view.lines[0]).toMatchObject({ pickedQty: 4, reservedQty: 0 });
    await expectReconciled();
  });

  it("stays consistent with many orders picking from shared bins while new orders reserve", async () => {
    const s = await createStore(ctx);
    const a = await scannable();
    const b = await scannable();
    await addStock(ctx, s, { productId: a.productId, quantity: 40, locationId: s.binA });
    await addStock(ctx, s, { productId: b.productId, quantity: 40, locationId: s.binB });

    const accepted = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        order(
          s,
          i % 2 === 0
            ? [{ productId: a.productId, quantity: 2 }, { productId: b.productId, quantity: 2 }]
            : [{ productId: b.productId, quantity: 2 }, { productId: a.productId, quantity: 2 }],
        ),
      ),
    );
    await Promise.all(accepted.map((o) => f().startPicking(actor(s), o.orderId)));

    const work = accepted.flatMap((o) =>
      o.lines.map((line) => {
        const scan = line.productId === a.productId ? a : b;
        const bin = line.productId === a.productId ? s.binA : s.binB;
        return () => f().pick(actor(s), o.orderId, { orderItemId: line.orderItemId, locationId: bin, barcode: scan.barcode, quantity: 2 });
      }),
    );
    const newOrders = Array.from({ length: 10 }, () => () => order(s, [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]));
    const results = await Promise.allSettled([...work, ...newOrders].map((fn) => fn()));

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await onHand(s, a.productId, s.packing)).toBe(20);
    expect(await onHand(s, b.productId, s.packing)).toBe(20);
    await expectReconciled(s);
  });
});

describe("fulfilment permissions", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("lets pickers pick, packers pack and only managers settle shortages", async () => {
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const packer = (await signIn(ctx, server, [[store, "packer"]])).token;
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const { productId, barcode } = await scannable();
    await addStock(ctx, store, { productId, quantity: 3 });
    const accepted = await order(store, [{ productId, quantity: 3 }]);
    const itemId = accepted.lines[0]!.orderItemId;
    const path = `/stores/${store.storeId}/orders/${accepted.orderId}`;
    const call = (token: string, step: string, body?: unknown) =>
      server.request("POST", `${path}/${step}`, { token, body, key: randomUUID() });

    expect((await call(packer, "start-picking")).status).toBe(403);
    expect((await call(picker, "start-picking")).status).toBe(200);
    expect((await call(picker, "picks", { orderItemId: itemId, locationId: store.binA, barcode, quantity: 2 })).status).toBe(200);
    const short = await call(picker, "short-picks", { orderItemId: itemId, locationId: store.binA, quantity: 1, reason: "Missing" });
    expect(short.status).toBe(200);
    expect((await call(picker, "complete-picking")).status).toBe(200);

    const shortageId = short.body.openShortages[0].shortageId;
    expect((await call(picker, `shortages/${shortageId}/resolve`, { resolution: "remove", reason: "x" })).status).toBe(403);
    expect((await call(manager, `shortages/${shortageId}/resolve`, { resolution: "remove", reason: "Customer agreed" })).status).toBe(200);

    expect((await call(picker, "pack", { lines: [{ orderItemId: itemId, quantity: 2 }] })).status).toBe(403);
    const packed = await call(packer, "pack", { lines: [{ orderItemId: itemId, quantity: 2 }] });
    expect(packed.status).toBe(200);
    expect(packed.body.status).toBe("ready_for_handover");
    expect((await call(packer, "handover")).body.status).toBe("handed_over");

    const view = await server.request("GET", `${path}/fulfilment`, { token: picker });
    expect(view.body.lines[0]).toMatchObject({ requestedQty: 3, pickedQty: 2, fulfilledQty: 2 });
  });
});
