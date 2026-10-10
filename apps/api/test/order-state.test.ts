import { eq } from "drizzle-orm";
import { orders } from "@dse/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidStateTransitionError } from "../src/common/errors";
import { ORDER_TRANSITIONS, transitionOrder, type OrderStatus } from "../src/orders/order-state";
import {
  actor,
  addStock,
  createContext,
  createProduct,
  createStore,
  orderRef,
  type TestContext,
  type TestStore,
} from "./support/fixtures";

let ctx: TestContext;
let store: TestStore;

beforeAll(async () => {
  ctx = createContext(10);
  store = await createStore(ctx);
});
afterAll(() => ctx.handle.close());

const newOrder = async () => {
  const productId = await createProduct(ctx);
  await addStock(ctx, store, { productId, quantity: 1 });
  const order = await ctx.orders.acceptOrder(actor(store), {
    externalRef: orderRef(),
    lines: [{ productId, quantity: 1 }],
  });
  return order.orderId;
};

describe("order state transitions", () => {
  it("has terminal states with no way out", () => {
    expect(ORDER_TRANSITIONS.handed_over).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it("never allows reaching handover without passing through packing", () => {
    const into = (to: OrderStatus) =>
      (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((from) => ORDER_TRANSITIONS[from].includes(to));
    expect(into("ready_for_handover")).toEqual(["packing"]);
    expect(into("handed_over")).toEqual(["ready_for_handover"]);
  });

  it("rejects a transition the current state does not allow", async () => {
    const orderId = await newOrder();
    await expect(
      ctx.handle.db.transaction((tx) => transitionOrder(tx, store.storeId, orderId, "handed_over")),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("lets exactly one of two racing decisions made on the same state win", async () => {
    const orderId = await newOrder();
    // A manager starts picking while the shortage timeout, which saw the order
    // still in `accepted`, tries to flag it. Each acts only on what it observed.
    const outcomes = await Promise.allSettled([
      ctx.handle.db.transaction((tx) =>
        transitionOrder(tx, store.storeId, orderId, "picking", { expectedFrom: ["accepted"] }),
      ),
      ctx.handle.db.transaction((tx) =>
        transitionOrder(tx, store.storeId, orderId, "exception", { expectedFrom: ["accepted"] }),
      ),
    ]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    expect(won).toHaveLength(1);

    const [row] = await ctx.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    const winner = (won[0] as PromiseFulfilledResult<{ to: OrderStatus }>).value.to;
    expect(row!.status).toBe(winner);
    const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(InvalidStateTransitionError);
  });

  it("refuses a timeout decision once the order has moved on", async () => {
    const orderId = await newOrder();
    await ctx.handle.db.transaction((tx) => transitionOrder(tx, store.storeId, orderId, "picking"));
    await expect(
      ctx.handle.db.transaction((tx) =>
        transitionOrder(tx, store.storeId, orderId, "cancel_pending", { expectedFrom: ["accepted"] }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});
