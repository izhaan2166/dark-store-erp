import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { authSessions, userStoreRoles, users } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import type { Role } from "../src/auth/permissions";
import { addStock, createContext, createProduct, createStore, orderRef, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";

const PASSWORD = "a long test password";

let ctx: TestContext;
let server: TestServer;
let auth: AuthService;
let store: TestStore;
let otherStore: TestStore;

beforeAll(async () => {
  ctx = createContext(10);
  auth = new AuthService(ctx.handle);
  server = await startServer();
  store = await createStore(ctx);
  otherStore = await createStore(ctx);
});
afterAll(async () => {
  await server.app.close();
  await ctx.handle.close();
});

async function userWith(roles: [TestStore, Role][]): Promise<{ email: string; userId: string }> {
  const email = `user-${randomUUID().slice(0, 8)}@Example.test`;
  const userId = await auth.createUser({ email, name: "Staff", password: PASSWORD });
  for (const [s, role] of roles) await auth.grantRole(userId, s.storeId, role);
  return { email: email.toLowerCase(), userId };
}

async function tokenFor(roles: [TestStore, Role][]): Promise<{ token: string; userId: string }> {
  const { email, userId } = await userWith(roles);
  const res = await server.request("POST", "/auth/login", { body: { email, password: PASSWORD } });
  expect(res.status).toBe(200);
  return { token: res.body.token, userId };
}

describe("login and sessions", () => {
  it("signs in with email in any case and lists roles per store", async () => {
    const { email, userId } = await userWith([
      [store, "picker"],
      [store, "packer"],
    ]);
    const res = await server.request("POST", "/auth/login", { body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
    expect(res.body.stores).toEqual([{ storeId: store.storeId, roles: expect.arrayContaining(["picker", "packer"]) }]);
    expect(typeof res.body.token).toBe("string");

    // Only a hash of the token is stored.
    const rows = await ctx.handle.db.select().from(authSessions).where(eq(authSessions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(res.body.token);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const { email } = await userWith([[store, "picker"]]);
    const wrong = await server.request("POST", "/auth/login", { body: { email, password: "not the password" } });
    const unknown = await server.request("POST", "/auth/login", {
      body: { email: "nobody@example.test", password: PASSWORD },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("invalid_credentials");
  });

  it("refuses inactive users, even with a live session", async () => {
    const { email, userId } = await userWith([[store, "picker"]]);
    const login = await server.request("POST", "/auth/login", { body: { email, password: PASSWORD } });
    await ctx.handle.db.update(users).set({ status: "inactive" }).where(eq(users.id, userId));

    expect((await server.request("POST", "/auth/login", { body: { email, password: PASSWORD } })).status).toBe(401);
    expect((await server.request("GET", "/auth/me", { token: login.body.token })).status).toBe(401);
  });

  it("requires a session for private routes but not for health", async () => {
    expect((await server.request("GET", "/health")).status).toBe(200);
    const res = await server.request("GET", "/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
    expect((await server.request("GET", "/auth/me", { token: "made-up" })).status).toBe(401);
  });

  it("ends the session on logout", async () => {
    const { token } = await tokenFor([[store, "picker"]]);
    expect((await server.request("GET", "/auth/me", { token })).status).toBe(200);
    expect((await server.request("POST", "/auth/logout", { token })).status).toBe(204);
    expect((await server.request("GET", "/auth/me", { token })).status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const { token, userId } = await tokenFor([[store, "picker"]]);
    await ctx.handle.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.userId, userId));
    expect((await server.request("GET", "/auth/me", { token })).status).toBe(401);
  });
});

describe("order endpoints and permissions", () => {
  async function stockedProduct(s: TestStore, quantity = 10): Promise<string> {
    const productId = await createProduct(ctx);
    await addStock(ctx, s, { productId, quantity });
    return productId;
  }

  it("lets a store manager accept, view and cancel an order", async () => {
    const { token } = await tokenFor([[store, "store_manager"]]);
    const productId = await stockedProduct(store);
    const body = { externalRef: orderRef(), lines: [{ productId, quantity: 4 }] };

    const created = await server.request("POST", `/stores/${store.storeId}/orders`, { token, body, key: randomUUID() });
    expect(created.status).toBe(201);
    expect(created.body.fullyReserved).toBe(true);
    const orderId = created.body.orderId;

    const viewed = await server.request("GET", `/stores/${store.storeId}/orders/${orderId}`, { token });
    expect(viewed.status).toBe(200);
    expect(viewed.body.lines[0]).toMatchObject({ requestedQty: 4, reservedQty: 4, openShortageQty: 0 });

    const cancelled = await server.request("POST", `/stores/${store.storeId}/orders/${orderId}/cancel`, {
      token,
      body: { reason: "Customer called" },
      key: randomUUID(),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", releasedQty: 4 });
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });

  it("requires an Idempotency-Key and honours it", async () => {
    const { token } = await tokenFor([[store, "store_manager"]]);
    const productId = await stockedProduct(store);
    const body = { externalRef: orderRef(), lines: [{ productId, quantity: 2 }] };
    const path = `/stores/${store.storeId}/orders`;

    const missing = await server.request("POST", path, { token, body });
    expect(missing.status).toBe(422);

    const key = randomUUID();
    const first = await server.request("POST", path, { token, body, key });
    const replay = await server.request("POST", path, { token, body, key });
    expect(replay.body.orderId).toBe(first.body.orderId);

    const reused = await server.request("POST", path, { token, body: { ...body, externalRef: orderRef() }, key });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
  });

  it("lets a picker view orders but not create or cancel them", async () => {
    const manager = await tokenFor([[store, "store_manager"]]);
    const picker = await tokenFor([[store, "picker"]]);
    const productId = await stockedProduct(store);
    const created = await server.request("POST", `/stores/${store.storeId}/orders`, {
      token: manager.token,
      body: { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] },
      key: randomUUID(),
    });
    const orderId = created.body.orderId;

    expect((await server.request("GET", `/stores/${store.storeId}/orders/${orderId}`, { token: picker.token })).status).toBe(200);

    const create = await server.request("POST", `/stores/${store.storeId}/orders`, {
      token: picker.token,
      body: { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] },
      key: randomUUID(),
    });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe("forbidden");

    const cancel = await server.request("POST", `/stores/${store.storeId}/orders/${orderId}/cancel`, {
      token: picker.token,
      body: { reason: "x" },
      key: randomUUID(),
    });
    expect(cancel.status).toBe(403);
  });

  it("refuses receiving staff, who have no order permissions", async () => {
    const { token } = await tokenFor([[store, "receiving_staff"]]);
    const res = await server.request("GET", `/stores/${store.storeId}/orders/${randomUUID()}`, { token });
    expect(res.status).toBe(403);
  });

  it("keeps each store's orders to that store's staff", async () => {
    const manager = await tokenFor([[store, "store_manager"]]);
    const outsider = await tokenFor([[otherStore, "store_manager"]]);
    const productId = await stockedProduct(store);
    const created = await server.request("POST", `/stores/${store.storeId}/orders`, {
      token: manager.token,
      body: { externalRef: orderRef(), lines: [{ productId, quantity: 1 }] },
      key: randomUUID(),
    });
    const orderId = created.body.orderId;

    // No role in the store: indistinguishable from a store that does not exist.
    const direct = await server.request("GET", `/stores/${store.storeId}/orders/${orderId}`, { token: outsider.token });
    expect(direct.status).toBe(404);
    // Their own store id with someone else's order id finds nothing either.
    const sideways = await server.request("GET", `/stores/${otherStore.storeId}/orders/${orderId}`, {
      token: outsider.token,
    });
    expect(sideways.status).toBe(404);
    const cancel = await server.request("POST", `/stores/${otherStore.storeId}/orders/${orderId}/cancel`, {
      token: outsider.token,
      body: { reason: "x" },
      key: randomUUID(),
    });
    expect(cancel.status).toBe(404);

    expect((await server.request("GET", `/stores/not-a-uuid/orders/${orderId}`, { token: manager.token })).status).toBe(404);
  });

  it("applies a removed role on the next request", async () => {
    const { token, userId } = await tokenFor([[store, "store_manager"]]);
    const productId = await stockedProduct(store);
    const body = () => ({ externalRef: orderRef(), lines: [{ productId, quantity: 1 }] });
    const path = `/stores/${store.storeId}/orders`;
    expect((await server.request("POST", path, { token, body: body(), key: randomUUID() })).status).toBe(201);

    await ctx.handle.db.delete(userStoreRoles).where(eq(userStoreRoles.userId, userId));
    expect((await server.request("POST", path, { token, body: body(), key: randomUUID() })).status).toBe(404);
  });
});

describe("receiving endpoints and permissions", () => {
  it("lets receiving staff record a receipt but only a store manager approve it", async () => {
    const manager = await tokenFor([[store, "store_manager"]]);
    const receiver = await tokenFor([[store, "receiving_staff"]]);
    const picker = await tokenFor([[store, "picker"]]);
    const auditor = await tokenFor([[store, "auditor"]]);
    const productId = await createProduct(ctx);
    const base = `/stores/${store.storeId}`;

    const supplier = await server.request("POST", `${base}/suppliers`, {
      token: manager.token,
      body: { code: `SUP-${randomUUID().slice(0, 6)}`, name: "Supplier" },
      key: randomUUID(),
    });
    expect(supplier.status).toBe(201);
    const po = await server.request("POST", `${base}/purchase-orders`, {
      token: manager.token,
      body: {
        supplierId: supplier.body.supplierId,
        poNumber: `PO-${randomUUID().slice(0, 8)}`,
        lines: [{ productId, quantity: 20, unitCostPaise: 1500 }],
      },
      key: randomUUID(),
    });
    expect(po.status).toBe(201);

    // Receiving staff cannot raise purchase orders.
    expect(
      (
        await server.request("POST", `${base}/purchase-orders`, {
          token: receiver.token,
          body: { supplierId: supplier.body.supplierId, poNumber: "PO-X", lines: [{ productId, quantity: 1, unitCostPaise: 1 }] },
          key: randomUUID(),
        })
      ).status,
    ).toBe(403);

    const receipt = { purchaseOrderId: po.body.purchaseOrderId, receivingLocationId: store.receiving, lines: [{ productId, acceptedQty: 15 }] };
    expect((await server.request("POST", `${base}/goods-receipts`, { token: picker.token, body: receipt, key: randomUUID() })).status).toBe(403);

    const recorded = await server.request("POST", `${base}/goods-receipts`, { token: receiver.token, body: receipt, key: randomUUID() });
    expect(recorded.status).toBe(201);
    expect(recorded.body.status).toBe("pending_approval");
    const grnPath = `${base}/goods-receipts/${recorded.body.goodsReceiptId}`;

    expect((await server.request("GET", grnPath, { token: auditor.token })).status).toBe(200);
    expect(
      (await server.request("POST", `${grnPath}/approve`, { token: receiver.token, body: { reason: "ok" }, key: randomUUID() })).status,
    ).toBe(403);

    const approved = await server.request("POST", `${grnPath}/approve`, {
      token: manager.token,
      body: { reason: "Short delivery agreed with supplier" },
      key: randomUUID(),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("posted");

    const putaway = await server.request("POST", `${base}/putaways`, {
      token: receiver.token,
      body: { productId, fromLocationId: store.receiving, toLocationId: store.binA, quantity: 15 },
      key: randomUUID(),
    });
    expect(putaway.status).toBe(201);
    expect((await ctx.reconciliation.run(store.storeId)).ok).toBe(true);
  });
});
