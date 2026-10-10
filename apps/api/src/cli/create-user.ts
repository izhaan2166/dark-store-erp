/**
 * Creates a user with roles in a store, so the first admin can sign in.
 *
 *   CREATE_USER_PASSWORD='...' DATABASE_URL=... pnpm --filter @dse/api create-user \
 *     --email admin@example.com --name "Store Admin" --store DS01 --role super_admin
 *
 * `--store` is the store code. A store with that code is created, with
 * default settings, if it does not exist yet (`--store-name` names it).
 * The password comes from CREATE_USER_PASSWORD so it stays out of shell
 * history. Repeat --role to grant several.
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createDb, storeSettings, stores } from "@dse/db";
import { AuthService } from "../auth/auth.service";
import { ROLE_PERMISSIONS, type Role } from "../auth/permissions";

const USAGE =
  "Usage: CREATE_USER_PASSWORD=... create-user --email E --name N --store CODE [--store-name NAME] --role ROLE [--role ROLE]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      store: { type: "string" },
      "store-name": { type: "string" },
      role: { type: "string", multiple: true },
    },
  });
  const password = process.env.CREATE_USER_PASSWORD;
  const roles = (values.role ?? []) as Role[];
  const unknown = roles.filter((r) => !(r in ROLE_PERMISSIONS));
  if (!values.email || !values.name || !values.store || roles.length === 0 || !password || unknown.length) {
    console.error(USAGE);
    if (unknown.length) console.error(`Unknown roles: ${unknown.join(", ")}`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const handle = createDb(url);
  try {
    const { db } = handle;
    const storeCode = values.store;
    const storeId = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.code, storeCode));
      if (existing) return existing.id;
      const [created] = await tx
        .insert(stores)
        .values({ code: storeCode, name: values["store-name"] ?? storeCode })
        .returning({ id: stores.id });
      await tx.insert(storeSettings).values({ storeId: created!.id });
      console.log(`Created store ${storeCode} (${created!.id})`);
      return created!.id;
    });

    const auth = new AuthService(handle);
    const userId = await auth.createUser({ email: values.email, name: values.name, password });
    for (const role of roles) await auth.grantRole(userId, storeId, role);
    console.log(`Created ${values.email} (${userId}) with ${roles.join(", ")} in ${storeCode}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
