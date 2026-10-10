import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor, addStock, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let store: TestStore;
let server: TestServer;

beforeAll(async () => {
  ctx = createContext(10);
  store = await createStore(ctx);
  server = await startServer();
});
afterAll(async () => {
  await server.app.close();
  await ctx.handle.close();
});

describe("order list", () => {
  it("shows orders still being worked on, oldest first, with progress", async () => {
    const productId = await createProduct(ctx);
    await addStock(ctx, store, { productId, quantity: 3 });
    const first = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 4 }] });
    const second = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] });
    const cancelled = await ctx.orders.acceptOrder(actor(store), { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] });
    await ctx.orders.cancelOrder(actor(store), cancelled.orderId, "Customer changed their mind");

    const list = await ctx.orders.listOrders(store.storeId, {});
    expect(list.map((o) => o.orderId)).toEqual([first.orderId, second.orderId]);
    expect(list[0]).toMatchObject({ status: "accepted", lineCount: 1, requestedUnits: 4, pickedUnits: 0, openShortages: 1 });

    const done = await ctx.orders.listOrders(store.storeId, { status: "cancelled" });
    expect(done.map((o) => o.orderId)).toEqual([cancelled.orderId]);
    await expect(ctx.orders.listOrders(store.storeId, { status: "lost" })).rejects.toThrow(/Invalid filter/);
  });

  it("is visible to anyone who can see orders", async () => {
    const picker = (await signIn(ctx, server, [[store, "picker"]])).token;
    const receiving = (await signIn(ctx, server, [[store, "receiving_staff"]])).token;
    const path = `/stores/${store.storeId}/orders?status=accepted,picking`;
    const res = await server.request("GET", path, { token: picker });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((await server.request("GET", path, { token: receiving })).status).toBe(403);
  });
});
