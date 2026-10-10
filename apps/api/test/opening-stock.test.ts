import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { batches, inventoryBalances, inventoryMovements, locations, products, storeSettings } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createContext, createProduct, createStore, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(30);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

async function freshBin(purpose: "storage" | "packing" = "storage"): Promise<string> {
  const [row] = await ctx.handle.db
    .insert(locations)
    .values({ storeId: store.storeId, code: `OPEN-${randomUUID().slice(0, 8)}`, kind: "bin", purpose, allocatable: purpose === "storage" })
    .returning();
  return row!.id;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function balances(locationId: string) {
  return ctx.handle.db
    .select({ productId: inventoryBalances.productId, batchId: inventoryBalances.batchId, status: inventoryBalances.status, onHand: inventoryBalances.onHand })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.locationId, locationId));
}

describe("opening stock", () => {
  it("loads a counted bin as available stock, creates lots and seeds the average cost", async () => {
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    const milk = await createProduct(ctx, { batchTracked: true });
    const lot = `L-${randomUUID().slice(0, 6)}`;
    const result = await ctx.openingStock.load(actor(store), {
      locationId: bin,
      lines: [
        { productId: rice, quantity: 12, unitCostPaise: 5000 },
        { productId: milk, quantity: 8, lotCode: lot, expiryDate: inDays(5) },
      ],
    });

    const [batch] = await ctx.handle.db.select().from(batches).where(and(eq(batches.productId, milk), eq(batches.lotCode, lot)));
    expect(result.lines).toEqual([
      { productId: rice, batchId: null, quantity: 12 },
      { productId: milk, batchId: batch!.id, quantity: 8 },
    ]);
    expect(await balances(bin)).toEqual(
      expect.arrayContaining([
        { productId: rice, batchId: null, status: "available", onHand: 12 },
        { productId: milk, batchId: batch!.id, status: "available", onHand: 8 },
      ]),
    );
    const moves = await ctx.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.toLocationId, bin));
    expect(moves.map((m) => [m.movementType, m.sourceType, m.sourceId])).toEqual([
      ["opening_balance", "opening_stock", result.openingStockId],
      ["opening_balance", "opening_stock", result.openingStockId],
    ]);
    const [riceRow] = await ctx.handle.db.select().from(products).where(eq(products.id, rice));
    const [milkRow] = await ctx.handle.db.select().from(products).where(eq(products.id, milk));
    expect(riceRow!.avgUnitCostPaise).toBe(5000);
    expect(milkRow!.avgUnitCostPaise).toBeNull();
    expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
  });

  it("returns the first result for a replayed request and adds nothing", async () => {
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    const key = randomUUID();
    const request = { locationId: bin, lines: [{ productId: rice, quantity: 5 }] };
    const first = await ctx.openingStock.load(actor(store, key), request);
    const again = await ctx.openingStock.load(actor(store, key), request);
    expect(again).toEqual(first);
    expect(await balances(bin)).toMatchObject([{ onHand: 5 }]);
  });

  it("loads a bin only once, and never one that already has stock history", async () => {
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    await ctx.openingStock.load(actor(store), { locationId: bin, lines: [{ productId: rice, quantity: 5 }] });
    await expect(ctx.openingStock.load(actor(store), { locationId: bin, lines: [{ productId: rice, quantity: 5 }] })).rejects.toThrow(
      /already has stock history/,
    );

    const used = await freshBin();
    await addStock(ctx, store, { productId: rice, quantity: 1, locationId: used });
    await expect(ctx.openingStock.load(actor(store), { locationId: used, lines: [{ productId: rice, quantity: 3 }] })).rejects.toThrow(
      /already has stock history/,
    );
    expect(await balances(bin)).toMatchObject([{ onHand: 5 }]);
  });

  it("lets exactly one of many simultaneous loads into the same bin through", async () => {
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => ctx.openingStock.load(actor(store), { locationId: bin, lines: [{ productId: rice, quantity: 7 }] })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused.every((r) => /already has stock history/.test(String(r.reason)))).toBe(true);
    expect(await balances(bin)).toEqual([{ productId: rice, batchId: null, status: "available", onHand: 7 }]);
    expect(await ctx.reconciliation.run(store.storeId)).toMatchObject({ ok: true });
  });

  it("refuses lines that are not sellable stock in a storage bin", async () => {
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    const milk = await createProduct(ctx, { batchTracked: true });
    const retired = await createProduct(ctx, { status: "inactive" });
    const load = (lines: unknown[], locationId = bin) => ctx.openingStock.load(actor(store), { locationId, lines } as never);

    await expect(load([{ productId: milk, quantity: 1 }])).rejects.toThrow(/Lot code and expiry date are required/);
    await expect(load([{ productId: milk, quantity: 1, lotCode: "OLD", expiryDate: inDays(-1) }])).rejects.toThrow(/Expired stock/);
    await expect(load([{ productId: rice, quantity: 1, lotCode: "X", expiryDate: inDays(9) }])).rejects.toThrow(/not batch tracked/);
    await expect(load([{ productId: retired, quantity: 1 }])).rejects.toThrow(/unknown or inactive/);
    await expect(load([{ productId: rice, quantity: 1 }, { productId: rice, quantity: 2 }])).rejects.toThrow(/each product and lot once/);
    await expect(load([{ productId: rice, quantity: 0 }])).rejects.toThrow(/Invalid opening stock/);
    await expect(load([{ productId: rice, quantity: 1 }], await freshBin("packing"))).rejects.toThrow(/active storage location/);
    expect(await balances(bin)).toEqual([]);
  });

  it("checks expiry against the store's own date", async () => {
    const bin = await freshBin();
    const milk = await createProduct(ctx, { batchTracked: true });
    const [settings] = await ctx.handle.db.select().from(storeSettings).where(eq(storeSettings.storeId, store.storeId));
    expect(settings!.timezone).toBe("UTC");
    await expect(
      ctx.openingStock.load(actor(store), { locationId: bin, lines: [{ productId: milk, quantity: 1, lotCode: "TODAY", expiryDate: inDays(0) }] }),
    ).rejects.toThrow(/Expired stock/);
  });
});

describe("opening stock over HTTP", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.app.close());

  it("is for Store Managers only and needs an idempotency key", async () => {
    const manager = (await signIn(ctx, server, [[store, "store_manager"]])).token;
    const inventoryManager = (await signIn(ctx, server, [[store, "inventory_manager"]])).token;
    const bin = await freshBin();
    const rice = await createProduct(ctx);
    const path = `/stores/${store.storeId}/opening-stock`;
    const body = { locationId: bin, lines: [{ productId: rice, quantity: 4 }] };

    expect((await server.request("POST", path, { token: inventoryManager, body, key: randomUUID() })).status).toBe(403);
    expect((await server.request("POST", path, { token: manager, body })).status).toBe(422);
    const res = await server.request("POST", path, { token: manager, body, key: randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.lines).toEqual([{ productId: rice, batchId: null, quantity: 4 }]);
    const again = await server.request("POST", path, { token: manager, body, key: randomUUID() });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already has stock history/);
  });
});
