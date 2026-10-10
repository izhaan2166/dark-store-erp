/** Base class for business rule failures. `httpStatus` is what the API returns. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = "validation_failed";
  readonly httpStatus = 422;
}

export class NotFoundError extends DomainError {
  readonly code = "not_found";
  readonly httpStatus = 404;
}

export class ProductUnavailableError extends DomainError {
  readonly code = "product_unavailable";
  readonly httpStatus = 422;
}

export class InsufficientStockError extends DomainError {
  readonly code = "insufficient_stock";
  readonly httpStatus = 409;
}

export class DuplicateOrderError extends DomainError {
  readonly code = "duplicate_order";
  readonly httpStatus = 409;
}

/** The same idempotency key was reused with a different request body. */
export class IdempotencyConflictError extends DomainError {
  readonly code = "idempotency_key_reused";
  readonly httpStatus = 409;
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = "invalid_state_transition";
  readonly httpStatus = 409;
}

/** No valid session: the token is missing, unknown, expired or revoked. */
export class UnauthenticatedError extends DomainError {
  readonly code = "unauthenticated";
  readonly httpStatus = 401;
}

export class InvalidCredentialsError extends DomainError {
  readonly code = "invalid_credentials";
  readonly httpStatus = 401;
}

/** Signed in, but no role in this store grants the action. */
export class ForbiddenError extends DomainError {
  readonly code = "forbidden";
  readonly httpStatus = 403;
}
