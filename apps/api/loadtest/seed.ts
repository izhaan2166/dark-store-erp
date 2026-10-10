/**
 * Seeds a load-test store: 5,000 active products (a third with two lots),
 * 200 storage bins with opening stock, the non-storage areas, a manager and
 * 30 staff who can pick and pack. Writes the ids the k6 script needs to
 * loadtest/data.json.
 *
 *   LOADTEST_DATABASE_URL=postgres://…/erp_loadtest pnpm --filter @dse/api loadtest:seed
 *
 * Test data never goes into a live database: the database name must contain
 * "loadtest" or "staging". Stock goes in through the ledger as opening
 * balances, so reconciliation holds from the start.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { batches, createDb, locations, productBarcodes, products, storeSettings, stores } from "@dse/db";
import { AuthService } from "../src/auth/auth.service";
import { LedgerService } from "../src/inventory/ledger.service";

const PRODUCTS = Number(process.env.LOADTEST_PRODUCTS ?? 5_000);
const BINS = 200;
const STAFF = 30;
/** The most-ordered products: about 5% of the catalogue takes most of the demand. */
const POPULAR = Math.ceil(PRODUCTS * 0.05);
const PASSWORD = process.env.LOADTEST_PASSWORD ?? "loadtest-password-1";

async function inChunks<T>(items: T[], size: number, run: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await run(items.slice(i, i + size));
}

async function main(): Promise<void> {
  const url = process.env.LOADTEST_DATABASE_URL;
  if (!url) throw new Error("LOADTEST_DATABASE_URL is not set");
  const dbName = new URL(url).pathname.slice(1);
  if (!/loadtest|staging/.test(dbName)) throw new Error(`Refusing to seed "${dbName}": use a database named for load tests or staging`);

  const run = randomUUID().slice(0, 6).toUpperCase();
  const handle = createDb(url, { max: 20 });
  const { db } = handle;
  try {
    const [store] = await db.insert(stores).values({ code: `LOAD-${run}`, name: `Load test ${run}` }).returning();
    await db.insert(storeSettings).values({ storeId: store!.id });
    const storeId = store!.id;

    const loc = (code: string, purpose: "storage" | "receiving" | "packing" | "quarantine") => ({
      storeId,
      code,
      kind: "bin" as const,
      purpose,
      allocatable: purpose === "storage",
    });
    const bins = await db
      .insert(locations)
      .values(Array.from({ length: BINS }, (_, i) => loc(`${String.fromCharCode(65 + Math.floor(i / 20))}-${String((i % 20) + 1).padStart(2, "0")}`, "storage")))
      .returning({ id: locations.id });
    await db.insert(locations).values([loc("RECV-1", "receiving"), loc("PACK-1", "packing"), loc("PACK-2", "packing"), loc("QUAR-1", "quarantine")]);

    const rows = Array.from({ length: PRODUCTS }, (_, i) => ({
      sku: `LT-${run}-${String(i + 1).padStart(5, "0")}`,
      name: `Load item ${i + 1}`,
      category: ["Dairy", "Staples", "Snacks", "Drinks", "Household"][i % 5]!,
      batchTracked: i % 3 === 0,
      avgUnitCostPaise: 2_000 + (i % 50) * 100,
    }));
    const created: { id: string; batchTracked: boolean }[] = [];
    await inChunks(rows, 1_000, async (chunk) => {
      created.push(...(await db.insert(products).values(chunk).returning({ id: products.id, batchTracked: products.batchTracked })));
    });
    const items = created.map((p, i) => ({ ...p, barcode: `LT${run}${String(i + 1).padStart(6, "0")}`, popular: i < POPULAR }));
    await inChunks(items, 1_000, (chunk) => db.insert(productBarcodes).values(chunk.map((p) => ({ productId: p.id, barcode: p.barcode }))));

    const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const lots: { productId: string; lotCode: string; expiryDate: string }[] = [];
    for (const p of items.filter((x) => x.batchTracked)) {
      lots.push({ productId: p.id, lotCode: `${run}-A`, expiryDate: day(20) }, { productId: p.id, lotCode: `${run}-B`, expiryDate: day(45) });
    }
    const batchIds = new Map<string, string[]>();
    await inChunks(lots, 1_000, async (chunk) => {
      for (const b of await db.insert(batches).values(chunk).returning({ id: batches.id, productId: batches.productId })) {
        batchIds.set(b.productId, [...(batchIds.get(b.productId) ?? []), b.id]);
      }
    });

    // Opening stock through the ledger: popular products get deep stock.
    const ledger = new LedgerService(handle);
    const auth = new AuthService(handle);
    const managerEmail = `manager-${run.toLowerCase()}@load.test`;
    const managerId = await auth.createUser({ email: managerEmail, name: "Load manager", password: PASSWORD });
    await auth.grantRole(managerId, storeId, "store_manager");

    type Post = { productId: string; batchId: string | null; quantity: number; locationId: string };
    const posts = items.flatMap((p, i): Post[] => {
      const quantity = p.popular ? 400 : 20 + (i % 40);
      const locationId = bins[i % BINS]!.id;
      const lots = batchIds.get(p.id);
      if (!lots) return [{ productId: p.id, batchId: null, quantity, locationId }];
      return lots.map((batchId) => ({ productId: p.id, batchId, quantity: Math.ceil(quantity / 2), locationId }));
    });
    let done = 0;
    await inChunks(posts, 20, (chunk) =>
      Promise.all(
        chunk.map((m) =>
          ledger.post({
            storeId,
            productId: m.productId,
            batchId: m.batchId,
            quantity: m.quantity,
            movementType: "opening_balance",
            sourceType: "load_test_seed",
            sourceId: run,
            actorUserId: managerId,
            to: { locationId: m.locationId, status: "available" },
          }),
        ),
      ).then(() => {
        done += chunk.length;
        if (done % 1_000 < 20) console.log(`Opening stock: ${done} of ${posts.length}`);
      }),
    );

    const staff: string[] = [];
    for (let i = 1; i <= STAFF; i++) {
      const email = `staff${i}-${run.toLowerCase()}@load.test`;
      const id = await auth.createUser({ email, name: `Staff ${i}`, password: PASSWORD });
      await auth.grantRole(id, storeId, "picker");
      await auth.grantRole(id, storeId, "packer");
      staff.push(email);
    }

    const out = join(__dirname, "data.json");
    writeFileSync(
      out,
      JSON.stringify({
        storeId,
        storeCode: `LOAD-${run}`,
        password: PASSWORD,
        manager: managerEmail,
        staff,
        products: items.map((p) => ({ productId: p.id, barcode: p.barcode, popular: p.popular })),
      }),
    );
    console.log(`Seeded store LOAD-${run}: ${items.length} products, ${posts.length} stock rows, ${STAFF} staff. Wrote ${out}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
