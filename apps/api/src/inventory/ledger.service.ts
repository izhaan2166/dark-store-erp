import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { inventoryBalances, inventoryMovements, type DbExecutor, type DbHandle } from "@dse/db";
import { InsufficientStockError, ValidationError } from "../common/errors";
import { DB_HANDLE } from "../database/database.tokens";

export type StockStatus = (typeof inventoryBalances.$inferSelect)["status"];
export type MovementType = (typeof inventoryMovements.$inferInsert)["movementType"];

export interface StockSide {
  locationId: string;
  status: StockStatus;
}

export interface MovementInput {
  storeId: string;
  productId: string;
  batchId: string | null;
  quantity: number;
  movementType: MovementType;
  /** The document that caused the movement, e.g. ("goods_receipt", grnId). */
  sourceType: string;
  sourceId: string;
  actorUserId: string;
  reason?: string;
  from?: StockSide;
  to?: StockSide;
  /**
   * How many of the moved units were reserved on the `from` balance and are
   * being consumed by this movement (a pick). The caller updates the matching
   * reservation allocations in the same transaction.
   */
  consumeReserved?: number;
}

export interface PostedMovement {
  movementId: number;
  fromBalanceId?: number;
  toBalanceId?: number;
}

type LockedBalance = {
  id: number;
  location_id: string;
  status: StockStatus;
  on_hand: number;
  reserved: number;
};

/**
 * The only code that changes physical stock. Each call writes one movement
 * and updates the affected balance rows in the caller's transaction.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  /** Posts a movement in its own transaction. */
  async post(input: MovementInput): Promise<PostedMovement> {
    return this.handle.db.transaction((tx) => this.postIn(tx, input));
  }

  /** Posts a movement inside an existing transaction. */
  async postIn(tx: DbExecutor, input: MovementInput): Promise<PostedMovement> {
    validate(input);
    const { from, to } = input;
    const consumeReserved = input.consumeReserved ?? 0;

    // Make sure the destination bucket exists so both rows can be locked
    // together, in primary-key order like every other stock transaction.
    if (to) {
      await tx
        .insert(inventoryBalances)
        .values({
          storeId: input.storeId,
          locationId: to.locationId,
          productId: input.productId,
          batchId: input.batchId,
          status: to.status,
        })
        .onConflictDoNothing();
    }

    const sides = [from, to].filter((s): s is StockSide => Boolean(s));
    const sideMatch = sql.join(
      sides.map((s) => sql`(location_id = ${s.locationId} AND status = ${s.status})`),
      sql` OR `,
    );
    const locked = await tx.execute<LockedBalance>(sql`
      SELECT id, location_id, status, on_hand, reserved
      FROM inventory_balances
      WHERE store_id = ${input.storeId}
        AND product_id = ${input.productId}
        AND batch_id IS NOT DISTINCT FROM ${input.batchId}
        AND (${sideMatch})
      ORDER BY id
      FOR UPDATE`);

    const find = (side: StockSide) =>
      locked.rows.find((r) => r.location_id === side.locationId && r.status === side.status);

    const result: Partial<PostedMovement> = {};

    if (from) {
      const row = find(from);
      const free = row ? row.on_hand - row.reserved : 0;
      const unreservedNeeded = input.quantity - consumeReserved;
      if (!row || unreservedNeeded > free || consumeReserved > row.reserved) {
        throw new InsufficientStockError("Not enough stock at the source location", {
          productId: input.productId,
          batchId: input.batchId,
          from,
          requested: input.quantity,
          onHand: row?.on_hand ?? 0,
          reserved: row?.reserved ?? 0,
        });
      }
      await tx.execute(sql`
        UPDATE inventory_balances
        SET on_hand = on_hand - ${input.quantity},
            reserved = reserved - ${consumeReserved},
            updated_at = now()
        WHERE id = ${row.id}`);
      result.fromBalanceId = Number(row.id);
    }

    if (to) {
      const row = find(to);
      if (!row) throw new Error("Destination balance row was not created");
      await tx.execute(sql`
        UPDATE inventory_balances
        SET on_hand = on_hand + ${input.quantity}, updated_at = now()
        WHERE id = ${row.id}`);
      result.toBalanceId = Number(row.id);
    }

    const [movement] = await tx
      .insert(inventoryMovements)
      .values({
        storeId: input.storeId,
        productId: input.productId,
        batchId: input.batchId,
        fromLocationId: from?.locationId ?? null,
        fromStatus: from?.status ?? null,
        toLocationId: to?.locationId ?? null,
        toStatus: to?.status ?? null,
        quantity: input.quantity,
        movementType: input.movementType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reason: input.reason ?? null,
        actorUserId: input.actorUserId,
      })
      .returning({ id: inventoryMovements.id });

    return { movementId: movement!.id, ...result };
  }
}

function validate(input: MovementInput): void {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new ValidationError("Movement quantity must be a positive whole number");
  }
  if (!input.from && !input.to) {
    throw new ValidationError("A movement needs a source, a destination or both");
  }
  if (input.from && input.to && input.from.locationId === input.to.locationId && input.from.status === input.to.status) {
    throw new ValidationError("Source and destination are the same stock bucket");
  }
  const consume = input.consumeReserved ?? 0;
  if (!Number.isInteger(consume) || consume < 0 || consume > input.quantity) {
    throw new ValidationError("consumeReserved must be between 0 and the movement quantity");
  }
  if (consume > 0 && input.from?.status !== "available") {
    throw new ValidationError("Only available stock can carry reservations");
  }
}
