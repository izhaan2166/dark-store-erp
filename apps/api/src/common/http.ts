import { z } from "zod";
import { NotFoundError, ValidationError } from "./errors";

const uuid = z.string().uuid();

/** Route ids that are not UUIDs cannot exist, so they are a 404, not a database error. */
export function idParam(id: string, what: string): string {
  if (!uuid.safeParse(id).success) throw new NotFoundError(`${what} not found`, { id });
  return id;
}

export function requireIdempotencyKey(key: string | undefined): string {
  if (!key) throw new ValidationError("The Idempotency-Key header is required");
  return key;
}
