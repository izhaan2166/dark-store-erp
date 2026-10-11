import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, idempotencyKeys } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, createStore, type TestContext, type TestStore } from "./support/fixtures";
import { startServer, type TestServer } from "./support/http";
import { signIn } from "./support/users";

let ctx: TestContext;
let server: TestServer;
let store: TestStore;
let otherStore: TestStore;
let manager: { token: string; userId: string };

beforeAll(async () => {
  ctx = createContext(10);
  server = await startServer();
  store = await createStore(ctx);
  otherStore = await createStore(ctx);
  manager = await signIn(ctx, server, [[store, "store_manager"]]);
});
afterAll(async () => {
  await server.app.close();
  await ctx.handle.close();
});

const email = () => `new-${randomUUID().slice(0, 8)}@Example.test`;
const staffPath = () => `/stores/${store.storeId}/staff`;

async function add(roles: string[], password = "first password 1") {
  const address = email();
  const res = await server.request("POST", staffPath(), {
    token: manager.token,
    key: randomUUID(),
    body: { name: "Ravi Kumar", email: address, password, roles },
  });
  return { res, email: address.toLowerCase(), password };
}

const login = (address: string, password: string) => server.request("POST", "/auth/login", { body: { email: address, password } });

describe("staff", () => {
  it("adds a person who can sign in with the roles given, and lists them", async () => {
    const { res, email: address, password } = await add(["packer", "picker", "picker"]);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ userId: expect.any(String), name: "Ravi Kumar", email: address, roles: ["packer", "picker"], editable: true });

    const signedIn = await login(address, password);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.stores[0].permissions).toEqual(expect.arrayContaining(["orders.pick", "orders.pack"]));

    const list = await server.request("GET", staffPath(), { token: manager.token });
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: res.body.userId, roles: ["packer", "picker"], editable: true }),
        expect.objectContaining({ userId: manager.userId, editable: false }),
      ]),
    );
  });

  it("keeps the password out of the idempotency record and the audit log", async () => {
    const { res, password } = await add(["picker"], "secret words 99");
    const keys = await ctx.handle.db
      .select({ hash: idempotencyKeys.requestHash, response: idempotencyKeys.response })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.storeId, store.storeId), eq(idempotencyKeys.scope, "staff.add")));
    const audit = await ctx.handle.db.select().from(auditLogs).where(eq(auditLogs.entityId, res.body.userId));
    expect(JSON.stringify([keys, audit])).not.toContain(password);
    expect(audit[0]).toMatchObject({ action: "staff.add", after: { roles: ["picker"] } });
  });

  it("refuses a second account with the same email, a short password, no roles and Super Admin", async () => {
    const { email: address } = await add(["picker"]);
    const again = await server.request("POST", staffPath(), {
      token: manager.token,
      key: randomUUID(),
      body: { name: "Copy", email: address.toUpperCase(), password: "another password", roles: ["packer"] },
    });
    expect(again.status).toBe(409);
    expect((await add(["picker"], "short")).res.status).toBe(422);
    expect((await add([])).res.status).toBe(422);
    expect((await add(["super_admin"])).res.status).toBe(422);
  });

  it("changes roles at once and removes a person from the store", async () => {
    const { res, email: address, password } = await add(["picker"]);
    const userId = res.body.userId;
    const { token } = (await login(address, password)).body;
    const pack = () => server.request("GET", `/stores/${store.storeId}/orders?status=packing`, { token });
    expect((await server.request("GET", `/stores/${store.storeId}/dashboard`, { token })).status).toBe(403);

    const changed = await server.request("PUT", `${staffPath()}/${userId}/roles`, { token: manager.token, key: randomUUID(), body: { roles: ["auditor"] } });
    expect(changed.status).toBe(200);
    expect(changed.body.member.roles).toEqual(["auditor"]);
    expect((await server.request("GET", `/stores/${store.storeId}/dashboard`, { token })).status).toBe(200);

    const removed = await server.request("PUT", `${staffPath()}/${userId}/roles`, { token: manager.token, key: randomUUID(), body: { roles: [] } });
    expect(removed.body).toEqual({ member: null });
    expect((await pack()).status).toBe(404);
    const list = await server.request("GET", staffPath(), { token: manager.token });
    expect(list.body.map((p: { userId: string }) => p.userId)).not.toContain(userId);
    const audit = await ctx.handle.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, "staff.remove")));
    expect(audit[0]).toMatchObject({ before: { roles: ["auditor"] }, after: { roles: [] } });

    const again = await server.request("PUT", `${staffPath()}/${userId}/roles`, { token: manager.token, key: randomUUID(), body: { roles: ["picker"] } });
    expect(again.status).toBe(404);
  });

  it("sets a new password and ends the person's sessions", async () => {
    const { res, email: address, password } = await add(["picker"]);
    const { token } = (await login(address, password)).body;
    const set = await server.request("POST", `${staffPath()}/${res.body.userId}/password`, {
      token: manager.token,
      key: randomUUID(),
      body: { password: "brand new password" },
    });
    expect(set.status).toBe(200);
    expect((await server.request("GET", "/auth/me", { token })).status).toBe(401);
    expect((await login(address, password)).status).toBe(401);
    expect((await login(address, "brand new password")).status).toBe(200);
  });

  it("will not let a manager change themselves, a Super Admin or someone from another store", async () => {
    const self = await server.request("PUT", `${staffPath()}/${manager.userId}/roles`, { token: manager.token, key: randomUUID(), body: { roles: ["picker"] } });
    expect(self.status).toBe(403);

    const admin = await signIn(ctx, server, [[store, "super_admin"]]);
    const shared = await signIn(ctx, server, [
      [store, "picker"],
      [otherStore, "picker"],
    ]);
    for (const target of [admin, shared]) {
      const roles = await server.request("PUT", `${staffPath()}/${target.userId}/roles`, { token: manager.token, key: randomUUID(), body: { roles: [] } });
      expect(roles.status).toBe(403);
      const pw = await server.request("POST", `${staffPath()}/${target.userId}/password`, { token: manager.token, key: randomUUID(), body: { password: "taken over 123" } });
      expect(pw.status).toBe(403);
    }
    const list = await server.request("GET", staffPath(), { token: manager.token });
    for (const target of [admin, shared]) expect(list.body.find((p: { userId: string }) => p.userId === target.userId).editable).toBe(false);

    const stranger = await signIn(ctx, server, [[otherStore, "picker"]]);
    const elsewhere = await server.request("POST", `${staffPath()}/${stranger.userId}/password`, { token: manager.token, key: randomUUID(), body: { password: "taken over 123" } });
    expect(elsewhere.status).toBe(404);
  });

  it("is for Store Managers only", async () => {
    const inventory = await signIn(ctx, server, [[store, "inventory_manager"]]);
    expect((await server.request("GET", staffPath(), { token: inventory.token })).status).toBe(403);
  });
});
