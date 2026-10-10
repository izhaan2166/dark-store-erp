import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLogs, batches, locations, outboxEvents, stockRequests, storeSettings, type DbExecutor, type DbHandle } from "@dse/db";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { InsufficientStockError, InvalidStateTransitionError, NotFoundError, ValidationError } from "../common/errors";
import { runIdempotent } from "../common/idempotency";
import { withTransactionRetry } from "../common/retry";
import { parse } from "../common/validation";
import { DB_HANDLE } from "../database/database.tokens";
import { LedgerService, type StockStatus } from "./ledger.service";

const reason = z.string().trim().min(1).max(500);
const quantity = z.number().int().positive().max(1_000_000);

export const quarantineSchema = z.object({
  productId: z.string().uuid(),
  batchId: z.string().uuid().nullable().default(null),
  /** The storage bin the units are taken from. */
  fromLocationId: z.string().uuid(),
  /** A quarantine area. */
  toLocationId: z.string().uuid(),
  quantity,
  reason,
});
export type QuarantineRequest = z.input<typeof quarantineSchema>;

export const releaseSchema = z.object({
  productId: z.string().uuid(),
  batchId: z.string().uuid().nullable().default(null),
  /** Where the blocked units are now. */
  fromLocationId: z.string().uuid(),
  /** The storage bin they go back to. */
  toLocationId: z.string().uuid(),
  quantity,
  reason,
});
export type ReleaseRequest = z.input<typeof releaseSchema>;

export const writeOffSchema = z.object({
  productId: z.string().uuid(),
  batchId: z.string().uuid().nullable().default(null),
  locationId: z.string().uuid(),
  status: z.enum(["available", "quarantined", "damaged", "expired"]),
  quantity,
  reason,
});
export type WriteOffRequest = z.input<typeof writeOffSchema>;

export const decisionSchema = z.object({ reason });

export type StockRequestView = typeof stockRequests.$inferSelect;

/**
 * Quarantine, quarantine release and write-off.
 *
 * Blocking stock is always allowed and takes effect at once: it can only
 * make less stock sellable. Putting quarantined stock back on sale and
 * writing stock off always need a Store Manager's approval with a reason,
 * and move stock only when approved. Damaged and expired stock can be
 * written off but never released.
 */
@Injectable()
export class StockControlService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async quarantine(actor: Actor, request: QuarantineRequest): Promise<{ movementId: number }> {
    const body = parse(quarantineSchema, request, "Invalid quarantine");
    return this.write(actor, "stock.quarantine", body, async (tx) => {
      await this.requireLocation(tx, actor.storeId, body.fromLocationId, "storage");
      await this.requireLocation(tx, actor.storeId, body.toLocationId, "quarantine");
      const posted = await this.ledger
        .postIn(tx, {
          storeId: actor.storeId,
          productId: body.productId,
          batchId: body.batchId,
          quantity: body.quantity,
          movementType: "status_change",
          sourceType: "quarantine",
          sourceId: actor.idempotencyKey,
          actorUserId: actor.actorUserId,
          reason: body.reason,
          from: { locationId: body.fromLocationId, status: "available" },
          to: { locationId: body.toLocationId, status: "quarantined" },
        })
        .catch(reservedHint);
      await this.audit(tx, actor, "stock.quarantine", "inventory_movement", String(posted.movementId), body);
      return { movementId: posted.movementId };
    });
  }

  async requestRelease(actor: Actor, request: ReleaseRequest): Promise<StockRequestView> {
    const body = parse(releaseSchema, request, "Invalid release request");
    return this.write(actor, "stock.request_release", body, async (tx) => {
      await this.requireLocation(tx, actor.storeId, body.toLocationId, "storage");
      await this.requireHeld(tx, actor.storeId, body.productId, body.batchId, body.fromLocationId, "quarantined", body.quantity);
      return this.createRequest(tx, actor, {
        kind: "release",
        productId: body.productId,
        batchId: body.batchId,
        fromLocationId: body.fromLocationId,
        fromStatus: "quarantined",
        toLocationId: body.toLocationId,
        quantity: body.quantity,
        reason: body.reason,
      });
    });
  }

  async requestWriteOff(actor: Actor, request: WriteOffRequest): Promise<StockRequestView> {
    const body = parse(writeOffSchema, request, "Invalid write-off request");
    return this.write(actor, "stock.request_write_off", body, async (tx) => {
      await this.requireHeld(tx, actor.storeId, body.productId, body.batchId, body.locationId, body.status, body.quantity);
      return this.createRequest(tx, actor, {
        kind: "write_off",
        productId: body.productId,
        batchId: body.batchId,
        fromLocationId: body.locationId,
        fromStatus: body.status,
        toLocationId: null,
        quantity: body.quantity,
        reason: body.reason,
      });
    });
  }

  async approve(actor: Actor, requestId: string, decision: { reason?: string }): Promise<StockRequestView> {
    return this.decide(actor, requestId, decision, "approved");
  }

  async reject(actor: Actor, requestId: string, decision: { reason?: string }): Promise<StockRequestView> {
    return this.decide(actor, requestId, decision, "rejected");
  }

  private async decide(
    actor: Actor,
    requestId: string,
    decision: { reason?: string },
    to: "approved" | "rejected",
  ): Promise<StockRequestView> {
    const { reason: why } = parse(decisionSchema, decision, "A reason is required");
    return this.write(actor, to === "approved" ? "stock.approve_request" : "stock.reject_request", { requestId, reason: why }, async (tx) => {
      const [request] = await tx
        .update(stockRequests)
        .set({ status: to, decidedBy: actor.actorUserId, decisionReason: why, decidedAt: new Date() })
        .where(
          and(
            eq(stockRequests.id, requestId),
            eq(stockRequests.storeId, actor.storeId),
            eq(stockRequests.status, "pending_approval"),
          ),
        )
        .returning();
      if (!request) {
        await this.getRequest(actor.storeId, requestId, tx);
        throw new InvalidStateTransitionError("This request is not waiting for approval", { requestId });
      }

      if (to === "approved") {
        if (request.kind === "release") {
          await this.requireNotExpired(tx, actor.storeId, request.batchId);
          await this.requireLocation(tx, actor.storeId, request.toLocationId!, "storage");
        }
        await this.ledger
          .postIn(tx, {
            storeId: actor.storeId,
            productId: request.productId,
            batchId: request.batchId,
            quantity: request.quantity,
            movementType: request.kind === "release" ? "status_change" : "write_off",
            sourceType: "stock_request",
            sourceId: request.id,
            actorUserId: actor.actorUserId,
            reason: request.reason,
            from: { locationId: request.fromLocationId, status: request.fromStatus },
            to: request.kind === "release" ? { locationId: request.toLocationId!, status: "available" } : undefined,
          })
          .catch(reservedHint);
      }
      await this.audit(tx, actor, `stock_request.${to === "approved" ? "approve" : "reject"}`, "stock_request", request.id, {
        kind: request.kind,
        quantity: request.quantity,
        reason: why,
      });
      await tx.insert(outboxEvents).values({
        storeId: actor.storeId,
        eventType: `stock_request.${to}`,
        payload: { requestId: request.id, kind: request.kind },
      });
      return request;
    });
  }

  async getRequest(storeId: string, requestId: string, executor: DbExecutor = this.handle.db): Promise<StockRequestView> {
    const [request] = await executor
      .select()
      .from(stockRequests)
      .where(and(eq(stockRequests.id, requestId), eq(stockRequests.storeId, storeId)));
    if (!request) throw new NotFoundError("Request not found", { requestId });
    return request;
  }

  /** The approval queue, newest first. */
  async listRequests(storeId: string, query: unknown): Promise<StockRequestView[]> {
    const { status } = parse(
      z.object({ status: z.enum(["pending_approval", "approved", "rejected"]).default("pending_approval") }),
      query,
      "Invalid filter",
    );
    return this.handle.db
      .select()
      .from(stockRequests)
      .where(and(eq(stockRequests.storeId, storeId), eq(stockRequests.status, status)))
      .orderBy(desc(stockRequests.createdAt))
      .limit(200);
  }

  private async createRequest(
    tx: DbExecutor,
    actor: Actor,
    values: Omit<typeof stockRequests.$inferInsert, "storeId" | "requestedBy">,
  ): Promise<StockRequestView> {
    const [request] = await tx
      .insert(stockRequests)
      .values({ ...values, storeId: actor.storeId, requestedBy: actor.actorUserId })
      .returning();
    await this.audit(tx, actor, `stock_request.${values.kind}`, "stock_request", request!.id, values);
    await tx.insert(outboxEvents).values({
      storeId: actor.storeId,
      eventType: "stock_request.approval_requested",
      payload: { requestId: request!.id, kind: values.kind },
    });
    return request!;
  }

  /** Early feedback only; the ledger checks again when the request is approved. */
  private async requireHeld(
    tx: DbExecutor,
    storeId: string,
    productId: string,
    batchId: string | null,
    locationId: string,
    status: StockStatus,
    quantity: number,
  ): Promise<void> {
    const [row] = (
      await tx.execute<{ free: number }>(sql`
        SELECT coalesce(sum(on_hand - reserved), 0)::int AS free FROM inventory_balances
        WHERE store_id = ${storeId} AND location_id = ${locationId} AND product_id = ${productId}
          AND batch_id IS NOT DISTINCT FROM ${batchId} AND status = ${status}`)
    ).rows;
    if (row!.free < quantity) {
      throw new InsufficientStockError(`Only ${row!.free} unreserved units are held there`, { free: row!.free });
    }
  }

  private async requireNotExpired(tx: DbExecutor, storeId: string, batchId: string | null): Promise<void> {
    if (!batchId) return;
    const [row] = await tx
      .select({ expired: sql<boolean>`${batches.expiryDate} <= (now() AT TIME ZONE ${storeSettings.timezone})::date` })
      .from(batches)
      .innerJoin(storeSettings, eq(storeSettings.storeId, storeId))
      .where(eq(batches.id, batchId));
    if (row?.expired) throw new ValidationError("This batch has expired and cannot go back on sale; write it off instead");
  }

  private async requireLocation(
    tx: DbExecutor,
    storeId: string,
    locationId: string,
    purpose: "storage" | "quarantine",
  ): Promise<void> {
    const [location] = await tx
      .select({ purpose: locations.purpose, status: locations.status })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.storeId, storeId)))
      .for("share");
    if (!location) throw new NotFoundError("Location not found", { locationId });
    if (location.status !== "active" || location.purpose !== purpose) {
      throw new ValidationError(`Location must be an active ${purpose} location`, { locationId });
    }
  }

  private async write<T>(actor: Actor, scope: string, request: unknown, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return withTransactionRetry(() =>
      this.handle.db.transaction((tx) =>
        runIdempotent(tx, { storeId: actor.storeId, scope, key: actor.idempotencyKey, request }, () => fn(tx)),
      ),
    );
  }

  private async audit(
    tx: DbExecutor,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLogs).values({ storeId: actor.storeId, actorUserId: actor.actorUserId, action, entityType, entityId, after });
  }
}

function reservedHint(err: unknown): never {
  if (err instanceof InsufficientStockError) {
    throw new InsufficientStockError(
      "Not enough unreserved units there; units reserved by orders must be short-picked first",
      err.details,
    );
  }
  throw err;
}
