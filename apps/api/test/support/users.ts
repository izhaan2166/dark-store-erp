import { randomUUID } from "node:crypto";
import { AuthService } from "../../src/auth/auth.service";
import type { Role } from "../../src/auth/permissions";
import type { TestContext, TestStore } from "./fixtures";
import type { TestServer } from "./http";

export const TEST_PASSWORD = "a long test password";

/** Creates a user with the given roles and signs them in over HTTP. */
export async function signIn(
  ctx: TestContext,
  server: TestServer,
  roles: [TestStore, Role][],
): Promise<{ token: string; userId: string }> {
  const auth = new AuthService(ctx.handle);
  const email = `user-${randomUUID().slice(0, 8)}@example.test`;
  const userId = await auth.createUser({ email, name: "Staff", password: TEST_PASSWORD });
  for (const [store, role] of roles) await auth.grantRole(userId, store.storeId, role);
  const res = await server.request("POST", "/auth/login", { body: { email, password: TEST_PASSWORD } });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status}`);
  return { token: res.body.token, userId };
}
