import { randomUUID } from "node:crypto";
import { batches, createDb, locations, products, storeSettings, stores, users, type DbHandle } from "@dse/db";
import { LedgerService } from "../../src/inventory/ledger.service";
import { ReconciliationService } from "../../src/inventory/reconciliation.service";
import { OrdersService } from "../../src/orders/orders.service";
import { PurchasingService } from "../../src/receiving/purchasing.service";
import { ReceivingService } from "../../src/receiving/receiving.service";
import { TEST_DATABASE_URL } from "./env";

export interface TestContext {
  handle: DbHandle;
  ledger: LedgerService;
  orders: OrdersService;
  reconciliation: ReconciliationService;
  purchasing: PurchasingService;
  receiving: ReceivingService;
}

export function createContext(poolSize = 60): TestContext {
  const handle = createDb(TEST_DATABASE_URL, { max: poolSize });
  const ledger = new LedgerService(handle);
  return {
    handle,
    ledger,
    purchasing: new PurchasingService(handle),
    receiving: new ReceivingService(handle, ledger),
    orders: new OrdersService(handle),
    reconciliation: new ReconciliationService(handle),
  };
}

export interface TestStore {
  storeId: string;
  userId: string;
  binA: string;
  binB: string;
  packing: string;
  quarantine: string;
  receiving: string;
}

const suffix = () => randomUUID().slice(0, 8);

/** A fresh store with two allocatable bins and the non-allocatable areas. */
export async function createStore(
  ctx: TestContext,
  settings: { sellByCutoffDays?: number; timezone?: string } = {},
): Promise<TestStore> {
  const { db } = ctx.handle;
  const [store] = await db.insert(stores).values({ code: `S-${suffix()}`, name: "Test store" }).returning();
  // UTC keeps expiry arithmetic in tests independent of the machine's clock zone.
  await db.insert(storeSettings).values({ storeId: store!.id, timezone: "UTC", ...settings });
  const [user] = await db
    .insert(users)
    .values({ email: `ops-${suffix()}@example.test`, name: "Ops user" })
    .returning();
  const loc = async (code: string, purpose: "storage" | "packing" | "quarantine" | "receiving", allocatable: boolean) => {
    const [row] = await db
      .insert(locations)
      .values({ storeId: store!.id, code, kind: "bin", purpose, allocatable })
      .returning();
    return row!.id;
  };
  return {
    storeId: store!.id,
    userId: user!.id,
    binA: await loc("A-01-01", "storage", true),
    binB: await loc("B-01-01", "storage", true),
    packing: await loc("PACK-1", "packing", false),
    quarantine: await loc("QUAR-1", "quarantine", false),
    receiving: await loc("RECV-1", "receiving", false),
  };
}

export async function createProduct(
  ctx: TestContext,
  opts: { batchTracked?: boolean; status?: "active" | "inactive" } = {},
): Promise<string> {
  const [row] = await ctx.handle.db
    .insert(products)
    .values({
      sku: `SKU-${suffix()}`,
      name: "Test product",
      category: "test",
      batchTracked: opts.batchTracked ?? false,
      status: opts.status ?? "active",
    })
    .returning();
  return row!.id;
}

/** A batch expiring `daysFromToday` days from today (negative = already expired). */
export async function createBatch(ctx: TestContext, productId: string, daysFromToday: number): Promise<string> {
  const expiry = new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
  const [row] = await ctx.handle.db
    .insert(batches)
    .values({ productId, lotCode: `LOT-${suffix()}`, expiryDate: expiry })
    .returning();
  return row!.id;
}

/** Puts opening stock straight into a location through the ledger. */
export async function addStock(
  ctx: TestContext,
  store: TestStore,
  opts: {
    productId: string;
    quantity: number;
    locationId?: string;
    batchId?: string | null;
    status?: "available" | "quarantined" | "damaged" | "expired" | "receiving";
  },
): Promise<void> {
  await ctx.ledger.post({
    storeId: store.storeId,
    productId: opts.productId,
    batchId: opts.batchId ?? null,
    quantity: opts.quantity,
    movementType: "opening_balance",
    sourceType: "test_seed",
    sourceId: randomUUID(),
    actorUserId: store.userId,
    to: { locationId: opts.locationId ?? store.binA, status: opts.status ?? "available" },
  });
}

export function actor(store: TestStore, idempotencyKey: string = randomUUID()) {
  return { storeId: store.storeId, actorUserId: store.userId, idempotencyKey };
}

export function orderRef(): string {
  return `ORD-${randomUUID()}`;
}
