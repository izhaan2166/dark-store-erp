const RETRYABLE_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

/** Postgres error code, whether thrown by `pg` directly or wrapped by Drizzle. */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

/**
 * Re-runs a whole transaction after a deadlock or serialization failure.
 * Safe because the failed attempt was rolled back in full, and writes carry
 * idempotency keys.
 */
export async function withTransactionRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt >= attempts || !code || !RETRYABLE_CODES.has(code)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
