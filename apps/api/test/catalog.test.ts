import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createBatch, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let server: TestServer;
let store: TestStore;
let otherStore: TestStore;
let manager: string;
let picker: string;
let base: string;

beforeAll(async () => {
  ctx = createContext(20);
  server = await startServer();
  store = await createStore(ctx);
  otherStore = await createStore(ctx);
  manager = (await signIn(ctx, server, [[store, "inventory_manager"]])).token;
  picker = (await signIn(ctx, server, [[store, "picker"]])).token;
  base = `/stores/${store.storeId}`;
});
afterAll(async () => {
  await server.app.close();
  await ctx.handle.close();
});

const unique = () => randomUUID().slice(0, 8).toUpperCase();
const post = (path: string, token: string, body: unknown) => server.request("POST", `${base}${path}`, { token, body, key: randomUUID() });
const patch = (path: string, token: string, body: unknown) =>
  server.request("PATCH", `${base}${path}`, { token, body, key: randomUUID() });

describe("products and barcodes", () => {
  it("creates a product that can be found by barcode, SKU or name", async () => {
    const sku = `MILK-${unique()}`;
    const code = `890${Date.now()}`;
    const created = await post("/products", manager, {
      sku,
      name: `Toned Milk 500ml ${sku}`,
      category: "dairy",
      batchTracked: true,
      barcodes: [code],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sku, batchTracked: true, status: "active", barcodes: [code] });

    const scanned = await server.request("GET", `${base}/barcodes/${code}`, { token: picker });
    expect(scanned.status).toBe(200);
    expect(scanned.body.productId).toBe(created.body.productId);

    const bySku = await server.request("GET", `${base}/products?q=${sku.toLowerCase()}`, { token: picker });
    expect(bySku.body.items.map((p: { sku: string }) => p.sku)).toEqual([sku]);
    const byBarcode = await server.request("GET", `${base}/products?q=${code}`, { token: picker });
    expect(byBarcode.body.items).toHaveLength(1);

    expect((await server.request("GET", `${base}/barcodes/000000000`, { token: picker })).status).toBe(404);
  });

  it("refuses duplicate SKUs and barcodes", async () => {
    const sku = `DUP-${unique()}`;
    const code = `DUP${unique()}`;
    await post("/products", manager, { sku, name: "One", category: "x", barcodes: [code] });
    const sameSku = await post("/products", manager, { sku, name: "Two", category: "x" });
    expect(sameSku.status).toBe(409);
    expect(sameSku.body.error.message).toMatch(/SKU/);
    const other = await post("/products", manager, { sku: `${sku}-B`, name: "Three", category: "x" });
    const sameCode = await post(`/products/${other.body.productId}/barcodes`, manager, { barcode: code });
    expect(sameCode.status).toBe(409);
    expect(sameCode.body.error.message).toMatch(/barcode/);
  });

  it("stops new orders for a product once it is made inactive", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 5 });
    const res = await patch(`/products/${productId}`, manager, { status: "inactive" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
    await expect(
      ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] }),
    ).rejects.toThrow(/inactive|unavailable/i);
  });

  it("lets pickers look products up but not change them", async () => {
    const res = await post("/products", picker, { sku: `P-${unique()}`, name: "No", category: "x" });
    expect(res.status).toBe(403);
    const productId = await createProduct(ctx);
    expect((await patch(`/products/${productId}`, picker, { name: "Renamed" })).status).toBe(403);
    expect((await server.request("GET", `${base}/products/${productId}`, { token: picker })).status).toBe(200);
  });
});

describe("locations", () => {
  it("makes storage bins sellable by default and other areas not", async () => {
    const bin = await post("/locations", manager, { code: `C-${unique()}`, kind: "bin" });
    expect(bin.status).toBe(201);
    expect(bin.body).toMatchObject({ purpose: "storage", allocatable: true, status: "active" });
    const dock = await post("/locations", manager, { code: `RECV-${unique()}`, kind: "zone", purpose: "receiving" });
    expect(dock.body.allocatable).toBe(false);

    const bad = await post("/locations", manager, { code: `Q-${unique()}`, kind: "bin", purpose: "quarantine", allocatable: true });
    expect(bad.status).toBe(422);
    expect((await patch(`/locations/${dock.body.locationId}`, manager, { allocatable: true })).status).toBe(422);
  });

  it("refuses duplicate codes and parents from another store", async () => {
    const code = `D-${unique()}`;
    await post("/locations", manager, { code, kind: "bin" });
    expect((await post("/locations", manager, { code, kind: "bin" })).status).toBe(409);
    const foreign = await post("/locations", manager, { code: `F-${unique()}`, kind: "bin", parentId: otherStore.binA });
    expect(foreign.status).toBe(404);
  });

  it("will not deactivate a location that still holds stock", async () => {
    const bin = (await post("/locations", manager, { code: `S-${unique()}`, kind: "bin" })).body;
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 3, locationId: bin.locationId });
    const res = await patch(`/locations/${bin.locationId}`, manager, { status: "inactive" });
    expect(res.status).toBe(409);
    expect(res.body.error.details.units).toBe(3);

    const empty = (await post("/locations", manager, { code: `E-${unique()}`, kind: "bin" })).body;
    expect((await patch(`/locations/${empty.locationId}`, manager, { status: "inactive" })).body.status).toBe("inactive");
  });

  it("never lets a putaway and a deactivation of the same bin both succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const bin = (await post("/locations", manager, { code: `R-${unique()}`, kind: "bin" })).body;
      const productId = await createProduct(ctx);
      await addStock(ctx, store, { productId, quantity: 2, locationId: store.receiving, status: "receiving" });
      const [putaway, deactivate] = await Promise.allSettled([
        ctx.receiving.putaway(actor(store), {
          productId,
          fromLocationId: store.receiving,
          toLocationId: bin.locationId,
          quantity: 2,
        }),
        ctx.catalog.updateLocation(actor(store), bin.locationId, { status: "inactive" }),
      ]);
      expect([putaway.status, deactivate.status]).not.toEqual(["fulfilled", "fulfilled"]);
    }
  });
});

describe("stock views", () => {
  it("separates on-hand by status and shows what can still be promised", async () => {
    const cutoffStore = await createStore(ctx, { sellByCutoffDays: 3 });
    const token = (await signIn(ctx, server, [[cutoffStore, "auditor"]])).token;
    const productId = await createProduct(ctx, { batchTracked: true });
    const fresh = await createBatch(ctx, productId, 30);
    const nearExpiry = await createBatch(ctx, productId, 2);
    await addStock(ctx, cutoffStore, { productId, quantity: 10, batchId: fresh });
    await addStock(ctx, cutoffStore, { productId, quantity: 4, batchId: nearExpiry });
    await addStock(ctx, cutoffStore, { productId, quantity: 3, batchId: fresh, locationId: cutoffStore.receiving, status: "receiving" });
    await addStock(ctx, cutoffStore, { productId, quantity: 1, batchId: fresh, locationId: cutoffStore.quarantine, status: "damaged" });
    await ctx.orders.acceptOrder(actor(cutoffStore), { externalRef: orderRef(), lines: [{ productId, quantity: 6 }] });

    const res = await server.request("GET", `/stores/${cutoffStore.storeId}/inventory/products/${productId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      productId,
      onHand: { available: 14, receiving: 3, damaged: 1, quarantined: 0, expired: 0 },
      reserved: 6,
      availableToPromise: 4,
      nearExpiryBlocked: 4,
    });

    const rows = await server.request("GET", `/stores/${cutoffStore.storeId}/inventory?productId=${productId}&status=available`, {
      token,
    });
    expect(rows.body.items).toHaveLength(2);
    expect(rows.body.items.map((r: { free: number }) => r.free).sort()).toEqual([4, 4]);

    // Another store's staff cannot read this store's stock.
    expect((await server.request("GET", `/stores/${cutoffStore.storeId}/inventory`, { token: picker })).status).toBe(404);
  });
});
