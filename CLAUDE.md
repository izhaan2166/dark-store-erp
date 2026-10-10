# Working on this repository

- Read `docs/decisions.md` before changing inventory, reservation or order behaviour. The architecture is frozen; raise a real problem before redesigning.
- Stock changes go through `LedgerService` only. Never write `on_hand` directly, and never UPDATE or DELETE `inventory_movements`.
- Lock order: order row first, then `inventory_balances` rows in primary-key order. Keep it that way in every new transaction.
- Status changes go through the transition helpers with conditional updates; add new states to `docs/state-machines.md`.
- Every write endpoint takes an idempotency key (`runIdempotent`).
- Run `pnpm test` against a disposable PostgreSQL (`DATABASE_URL_TEST`); the suite resets that schema. Any change touching stock needs a concurrency or reconciliation test.
- Schema changes: edit `packages/db/src/schema.ts`, run `pnpm db:generate`, commit the migration.
