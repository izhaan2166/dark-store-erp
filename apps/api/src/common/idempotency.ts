import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys, type DbExecutor } from "@dse/db";
import { IdempotencyConflictError, ValidationError } from "./errors";

export interface IdempotencyContext {
  storeId: string;
  /** The operation, e.g. "orders.accept". Keys are unique per store and scope. */
  scope: string;
  key: string;
  request: unknown;
}

/** Stable JSON: object keys sorted, so equal payloads hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRequest(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/**
 * Runs `fn` at most once per (store, scope, key), inside the caller's transaction.
 *
 * The key row is inserted first. A concurrent request with the same key blocks
 * on that insert until the first transaction ends, then sees its stored result.
 * The same key with a different payload is rejected, never answered with an
 * unrelated result.
 */
export async function runIdempotent<T>(tx: DbExecutor, ctx: IdempotencyContext, fn: () => Promise<T>): Promise<T> {
  if (!ctx.key || ctx.key.length > 200) {
    throw new ValidationError("An idempotency key of 1 to 200 characters is required");
  }
  const requestHash = hashRequest(ctx.request);

  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ storeId: ctx.storeId, scope: ctx.scope, key: ctx.key, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  const where = and(
    eq(idempotencyKeys.storeId, ctx.storeId),
    eq(idempotencyKeys.scope, ctx.scope),
    eq(idempotencyKeys.key, ctx.key),
  );

  if (claimed.length === 0) {
    const [existing] = await tx.select().from(idempotencyKeys).where(where);
    if (!existing) throw new Error("Idempotency key vanished after conflict");
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError("This idempotency key was already used with a different request", {
        scope: ctx.scope,
        key: ctx.key,
      });
    }
    return existing.response as T;
  }

  const result = await fn();
  await tx.update(idempotencyKeys).set({ response: result as object }).where(where);
  return result;
}
