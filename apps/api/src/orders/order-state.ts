import { and, eq, inArray, sql } from "drizzle-orm";
import { orders, type DbExecutor } from "@dse/db";
import { InvalidStateTransitionError, NotFoundError } from "../common/errors";

export type OrderStatus = (typeof orders.$inferSelect)["status"];

/**
 * Allowed order status changes. Anything not listed is rejected.
 * See docs/state-machines.md for the reasoning behind each edge.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  accepted: ["picking", "cancel_pending", "cancelled", "exception"],
  picking: ["packing", "cancel_pending", "cancelled", "exception"],
  packing: ["ready_for_handover", "picking", "cancel_pending", "cancelled", "exception"],
  ready_for_handover: ["handed_over", "cancel_pending", "cancelled", "exception"],
  cancel_pending: ["cancelled", "exception"],
  exception: ["picking", "packing", "cancel_pending", "cancelled"],
  handed_over: [],
  cancelled: [],
};

export function allowedSources(to: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((from) => ORDER_TRANSITIONS[from].includes(to));
}

/**
 * Moves an order to `to` only if its current status allows it. The check and
 * the write are one conditional UPDATE (compare-and-set), so two racing
 * callers cannot both act on the same starting state.
 *
 * `expectedFrom` narrows the allowed sources to the state(s) the caller based
 * its decision on. A shortage-timeout job passes the state it observed, so if
 * a manager has already moved the order on, the job's transition fails instead
 * of acting on stale information.
 */
export async function transitionOrder(
  tx: DbExecutor,
  storeId: string,
  orderId: string,
  to: OrderStatus,
  options: { expectedFrom?: readonly OrderStatus[] } = {},
): Promise<{ from: OrderStatus; to: OrderStatus }> {
  const sources = allowedSources(to).filter((s) => !options.expectedFrom || options.expectedFrom.includes(s));
  const [current] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)));
  if (!current) throw new NotFoundError("Order not found", { orderId });

  const updated =
    sources.length === 0
      ? []
      : await tx
          .update(orders)
          .set({ status: to, updatedAt: sql`now()` })
          .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId), inArray(orders.status, sources)))
          .returning({ id: orders.id });

  if (updated.length === 0) {
    throw new InvalidStateTransitionError(`Order cannot move from ${current.status} to ${to}`, {
      orderId,
      from: current.status,
      to,
    });
  }
  return { from: current.status, to };
}
