/** Who is making a write, in which store, under which idempotency key. */
export interface Actor {
  storeId: string;
  actorUserId: string;
  idempotencyKey: string;
}
