# Dark Store ERP

Inventory, receiving, order fulfilment and store operations for a single quick-commerce dark store, built so more stores can be added later.

The build plan and every agreed decision live in [docs/decisions.md](docs/decisions.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/db` | Drizzle schema, SQL migrations and the migration runner |
| `apps/api` | NestJS API: inventory ledger, reservations, orders |
| `docs` | Decisions, state machines and other design notes |

## Getting started

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env            # then point DATABASE_URL at your database
pnpm db:migrate                 # apply migrations to DATABASE_URL
pnpm build
node apps/api/dist/main.js      # GET /health reports API and database status
```

## Tests

Tests run against a real PostgreSQL database named by `DATABASE_URL_TEST`. **The suite drops and recreates that database's schema**, so never point it at data you care about.

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/erp_test pnpm test
```

The concurrency tests fire 50 simultaneous orders at 10 units of stock and check that no more than 10 are ever reserved, that opposite lock orders do not deadlock, and that cancellations racing with new orders leave the ledger reconciled.

## Changing the schema

Edit `packages/db/src/schema.ts`, then run `pnpm db:generate` and commit the new migration. CI fails if the schema and migrations disagree.
