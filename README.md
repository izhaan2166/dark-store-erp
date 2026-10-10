# Dark Store ERP

Inventory, receiving, order fulfilment and store operations for a single quick-commerce dark store, built so more stores can be added later.

The build plan and every agreed decision live in [docs/decisions.md](docs/decisions.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/db` | Drizzle schema, SQL migrations and the migration runner |
| `apps/api` | NestJS API and background worker: sign-in and roles, products and locations, inventory ledger, receiving, reservations, orders |
| `apps/web` | Phone and tablet app (React PWA) |
| `docs` | Decisions, state machines and other design notes |

## Getting started

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env            # then point DATABASE_URL at your database
pnpm db:migrate                 # apply migrations to DATABASE_URL
pnpm build
node apps/api/dist/main.js      # GET /health reports API and database status
node apps/api/dist/worker.js    # background jobs: shortage escalation, expiry sweep
```

The phone and tablet app lives in `apps/web` (React + Vite, installable as a PWA). For development run the API, then `pnpm --filter @dse/web dev`; it forwards `/api` calls to `API_URL` (default `http://localhost:3000`). In production serve `apps/web/dist` and the API from one origin, with `/api` routed to the API. It covers sign-in, typing in customer orders (and cancelling them), picking, packing and handover with a keyboard-wedge or Bluetooth scanner, writing purchase orders (and adding suppliers), receiving deliveries against a purchase order, putting stock away on shelves, blind shelf counts, blocking and writing off problem stock, the Store Manager's approvals and missing-items list (reserve again, substitute, or send without it), and setting up products (with barcodes) and shelves.

The worker runs every job once a minute (`WORKER_INTERVAL_MS` to change it). Running two workers is safe.

Create the first user (and the store, if it does not exist yet):

```bash
CREATE_USER_PASSWORD='choose-a-long-password' pnpm --filter @dse/api create-user \
  --email admin@example.com --name "Store Admin" --store DS01 --store-name "Pilot store" \
  --role super_admin
```

## API

Sign in with `POST /auth/login` (`{ "email", "password" }`) and send the returned token as `Authorization: Bearer <token>`. The response lists each store you work in with its name, your roles and your permissions. Sessions last 12 hours; `POST /auth/logout` ends one early and `GET /auth/me` lists your roles per store.

| Endpoint | Permission |
| --- | --- |
| `GET /stores/:storeId/products?q=` · `GET …/products/:productId` · `GET …/barcodes/:barcode` | `catalog.view` |
| `POST /stores/:storeId/products` · `PATCH …/products/:productId` · `POST …/products/:productId/barcodes` | `catalog.manage` |
| `GET /stores/:storeId/locations` | `catalog.view` |
| `POST /stores/:storeId/locations` · `PATCH …/locations/:locationId` | `locations.manage` |
| `GET /stores/:storeId/inventory?productId=&locationId=&status=` · `GET …/inventory/products/:productId` | `inventory.view` |
| `POST /stores/:storeId/stock-counts` (`{ "locationId", "lines": [{ "productId", "batchId", "countedQty" }] }`) | `inventory.count` |
| `GET /stores/:storeId/stock-counts?status=pending_approval` (with shelf, counter and differences) and `GET …/stock-counts/:stockCountId` | `inventory.view` |
| `POST …/stock-counts/:stockCountId/approve` or `/reject` (`{ "reason" }`) | `inventory.approve_count` |
| `POST /stores/:storeId/quarantines` (`{ "productId", "batchId", "fromLocationId", "toLocationId", "quantity", "reason" }`) | `inventory.adjust` |
| `POST /stores/:storeId/stock-requests/release` (same body as a quarantine) | `inventory.adjust` |
| `POST /stores/:storeId/stock-requests/write-off` (`{ "productId", "batchId", "locationId", "status", "quantity", "reason" }`) | `inventory.adjust` |
| `GET /stores/:storeId/stock-requests?status=pending_approval` and `GET …/stock-requests/:requestId` | `inventory.view` |
| `POST …/stock-requests/:requestId/approve` or `/reject` (`{ "reason" }`) | `inventory.approve_request` |
| `POST /stores/:storeId/orders` | `orders.create` |
| `GET /stores/:storeId/orders?status=accepted,picking` (oldest first, with progress) | `orders.view` |
| `GET /stores/:storeId/orders/:orderId` | `orders.view` |
| `POST /stores/:storeId/orders/:orderId/cancel` (`{ "reason" }`) | `orders.cancel` |
| `GET /stores/:storeId/orders/:orderId/fulfilment` (pick list, progress, open shortages) | `orders.view` |
| `POST …/orders/:orderId/start-picking` · `/picks` · `/short-picks` · `/complete-picking` | `orders.pick` |
| `GET /stores/:storeId/shortages` (open shortages across the store, escalated first) | `orders.view` |
| `POST …/orders/:orderId/shortages/:shortageId/resolve` (`{ "resolution": "reallocate" \| "remove", "reason" }`, or `{ "resolution": "substitute", "substituteProductId", "quantity", "reason" }`) | `orders.resolve_shortage` |
| `POST …/orders/:orderId/pack` · `/handover` | `orders.pack` |
| `POST /stores/:storeId/suppliers` | `purchasing.manage` |
| `POST /stores/:storeId/purchase-orders` | `purchasing.manage` |
| `GET /stores/:storeId/purchase-orders?status=open` (oldest first, with what is still to come) | `purchasing.view` |
| `GET /stores/:storeId/purchase-orders/:purchaseOrderId` | `purchasing.view` |
| `GET /stores/:storeId/goods-receipts?status=pending_approval` (with lines, supplier and receiver) | `purchasing.view` |
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
