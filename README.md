# Dark Store ERP

Inventory, receiving, order fulfilment and store operations for a single quick-commerce dark store, built so more stores can be added later.

The build plan and every agreed decision live in [docs/decisions.md](docs/decisions.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/db` | Drizzle schema, SQL migrations and the migration runner |
| `apps/api` | NestJS API: sign-in and roles, products and locations, inventory ledger, receiving, reservations, orders |
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

Create the first user (and the store, if it does not exist yet):

```bash
CREATE_USER_PASSWORD='choose-a-long-password' pnpm --filter @dse/api create-user \
  --email admin@example.com --name "Store Admin" --store DS01 --store-name "Pilot store" \
  --role super_admin
```

## API

Sign in with `POST /auth/login` (`{ "email", "password" }`) and send the returned token as `Authorization: Bearer <token>`. Sessions last 12 hours; `POST /auth/logout` ends one early and `GET /auth/me` lists your roles per store.

| Endpoint | Permission |
| --- | --- |
| `GET /stores/:storeId/products?q=` · `GET …/products/:productId` · `GET …/barcodes/:barcode` | `catalog.view` |
| `POST /stores/:storeId/products` · `PATCH …/products/:productId` · `POST …/products/:productId/barcodes` | `catalog.manage` |
| `GET /stores/:storeId/locations` | `catalog.view` |
| `POST /stores/:storeId/locations` · `PATCH …/locations/:locationId` | `locations.manage` |
| `GET /stores/:storeId/inventory?productId=&locationId=&status=` · `GET …/inventory/products/:productId` | `inventory.view` |
| `POST /stores/:storeId/orders` | `orders.create` |
| `GET /stores/:storeId/orders/:orderId` | `orders.view` |
| `POST /stores/:storeId/orders/:orderId/cancel` (`{ "reason" }`) | `orders.cancel` |
| `POST /stores/:storeId/suppliers` | `purchasing.manage` |
| `POST /stores/:storeId/purchase-orders` | `purchasing.manage` |
| `GET /stores/:storeId/purchase-orders/:purchaseOrderId` | `purchasing.view` |
| `POST /stores/:storeId/goods-receipts` | `receiving.record` |
| `GET /stores/:storeId/goods-receipts/:goodsReceiptId` | `purchasing.view` |
| `POST /stores/:storeId/goods-receipts/:goodsReceiptId/approve` or `/cancel` (`{ "reason" }`) | `receiving.approve` |
| `POST /stores/:storeId/putaways` | `inventory.putaway` |

Every write needs an `Idempotency-Key` header. Retrying with the same key and body returns the first result; the same key with a different body is rejected with `409 idempotency_key_reused`. Role permissions are in `apps/api/src/auth/permissions.ts`.

## Tests

Tests run against a real PostgreSQL database named by `DATABASE_URL_TEST`. **The suite drops and recreates that database's schema**, so never point it at data you care about.

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/erp_test pnpm test
```

The concurrency tests fire 50 simultaneous orders at 10 units of stock and check that no more than 10 are ever reserved, that opposite lock orders do not deadlock, and that cancellations racing with new orders leave the ledger reconciled.

## Changing the schema

Edit `packages/db/src/schema.ts`, then run `pnpm db:generate` and commit the new migration. CI fails if the schema and migrations disagree.
