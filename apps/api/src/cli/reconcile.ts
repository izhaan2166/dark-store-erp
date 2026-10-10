/**
 * Checks a store's stock records against each other: every balance against
 * the movement ledger, reserved quantities against open allocations, and
 * each order line against its allocations. Prints what differs and exits 1
 * if anything does, so it can run after a load test or as a nightly job.
 *
 *   DATABASE_URL=... pnpm --filter @dse/api reconcile --store DS01
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createDb, stores } from "@dse/db";
import { ReconciliationService } from "../inventory/reconciliation.service";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { store: { type: "string" } } });
  if (!values.store) {
    console.error("Usage: reconcile --store CODE");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const handle = createDb(url);
  try {
    const [store] = await handle.db.select({ id: stores.id }).from(stores).where(eq(stores.code, values.store));
    if (!store) throw new Error(`No store with code ${values.store}`);
    const report = await new ReconciliationService(handle).run(store.id);
    if (report.ok) {
      console.log(`${values.store}: stock records agree (balances, reservations and order lines).`);
      return;
    }
    console.log(`${values.store}: differences found`);
    console.log(JSON.stringify({ onHand: report.onHand, reserved: report.reserved, orderItems: report.orderItems }, null, 2));
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
