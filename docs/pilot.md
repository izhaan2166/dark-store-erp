# Pilot runbook

How to set up the pilot store, test the real devices, go live and keep the stock records right. Work through it in order; each section ends with the check that says it is done.

## 1. Server

- One Linux server (2 vCPU and 4 GB RAM is plenty for one store) with Node 22 and pnpm 10, and PostgreSQL 16, either on the same server or a managed database with daily backups and point-in-time restore.
- Two databases: `dark_store_erp` for live data and `erp_staging` for trying things and load tests. Test data never goes into the live database; the load-test seed refuses a database whose name lacks `loadtest` or `staging`.
- HTTPS on a real domain, with the web app and the API on one origin: serve `apps/web/dist` and route `/api` to the API (Caddy or nginx). Phones only install the app and keep a sign-in on HTTPS.
- Run the API (`node apps/api/dist/main.js`) and the worker (`node apps/api/dist/worker.js`) under systemd (or another process manager) so they restart after a crash or reboot. Set `DATABASE_URL` and `PORT` for both.

Deploy or upgrade:

```bash
git pull && pnpm install --frozen-lockfile
pnpm db:migrate        # with DATABASE_URL set
pnpm build
systemctl restart dark-store-api dark-store-worker
curl https://<domain>/api/health    # {"status":"ok","database":"up"}
```

Done when `/api/health` answers over HTTPS and the worker log shows `Worker running every 60000 ms`.

## 2. Backups and nightly checks

Add to the server's crontab (adjust paths):

```cron
# Nightly backup, kept 14 days
30 1 * * *  pg_dump -Fc "$DATABASE_URL" > /backups/erp-$(date +\%F).dump && find /backups -name 'erp-*.dump' -mtime +14 -delete
# Nightly stock check; exits 1 and prints the differences if any
0 2 * * *   cd /srv/dark-store-erp && DATABASE_URL=... pnpm --filter @dse/api reconcile --store DS01 >> /var/log/erp-reconcile.log 2>&1 || mail -s "Stock check found differences" you@example.com < /var/log/erp-reconcile.log
```

Copy the backups somewhere off the server. Before go-live, restore one backup into `erp_staging` (`pg_restore -d erp_staging --clean`) and sign in against it, so you know the restore works.

Done when a restored backup opens in staging and the first nightly `reconcile` prints `stock records agree`.

## 3. Store set-up

1. Create the first admin with `create-user` (see the README), then sign in and add the other staff with their roles. Give at least one person Store Manager: only a Store Manager approves write-offs, quarantine releases, large count differences (more than 2 units or ₹1,000 per product) and receiving differences over 5%.
2. Add the shelves (Shelves screen; a range like A-01 to A-20 in one go), plus an unloading area for deliveries, at least one packing area and a blocked stock area.
3. Add the products with their barcodes (Products screen). Mark products that carry lot numbers or expiry dates as batch-tracked.

Done when every shelf label and product barcode in the store scans to the right thing in the app.

## 4. Opening count

The store starts from a full count, entered shelf by shelf as opening stock.

1. Count each shelf: product, quantity, and for batch-tracked products the lot and expiry date.
2. Enter each shelf's count on the **Opening stock** screen (Store Managers have it): scan the shelf, scan or search each item and type how many, with the lot and expiry for batch-tracked items and the cost of one if known, then load it. Each shelf can be loaded once; after that, corrections go through Count stock.
3. Run `reconcile` for the store.
4. Spot-check ten shelves against the app's stock lookup.

Done when `reconcile` prints `stock records agree` and the spot checks match. Do not take orders before this.

## 5. Device testing

Test every device model the pilot will use, with the staff who will use it, before go-live. Note the device, scanner and result for each line.

**Scanner**

- [ ] The scanner pairs as a keyboard (HID mode) and sends Enter after each code.
- [ ] Product barcodes in the store scan: EAN-13, EAN-8, UPC-A and any in-house Code 128 labels.
- [ ] Shelf labels scan.
- [ ] Twenty fast scans in a row on the picking screen: each counts once, none are lost or joined together.
- [ ] After tapping a button, the next scan still lands in the scan box.
- [ ] A wrong item gives the red message and a double vibration.
- [ ] On a phone or tablet, the on-screen keyboard does not cover the order when the scan box has focus. If it does, note it; the fix is a setting on the scanner or device, not in the app.

**Device and app**

- [ ] The app installs to the home screen (Chrome menu, Install app or Add to Home screen) and opens full screen.
- [ ] Text and buttons are readable at arm's length in the store's light, and buttons are big enough to hit with gloves if staff wear them.
- [ ] A sign-in lasts a full shift (12 hours) without asking again.
- [ ] The battery lasts a shift with the scanner connected.

**Wi-Fi**

- [ ] Walk every aisle and the packing area with the app open: no dead spots.
- [ ] Turn Wi-Fi off mid-pick, scan, then turn it on. The app says "No connection", and once Wi-Fi is back the picked count matches what is actually in the basket.

**One full order per device**

- [ ] Enter a test order, pick it, pack it and hand it over, on each device model. Use a test product and cancel or reverse it afterwards, or do this in staging.

Done when every line passes on every device model, or the failures have a workaround the store manager accepts.

## 6. Load test

Run the load test against staging on the pilot server (see the README): the normal profile (120 orders an hour, 20 staff) and the stress profile (240 orders an hour, 30 staff), 15 minutes each, then `reconcile` on the load-test store.

Done when each screen's p95 is under 2 seconds, there are no server errors, and `reconcile` finds no differences.

## 7. Go-live and daily routine

- Each morning, the Store Manager opens **Today** and clears the exception queue: missing items, receipts and counts waiting for approval, problem-stock requests, stock waiting to be shelved, and stuck orders.
- Each evening, check that the nightly backup and `reconcile` ran. If `reconcile` reports differences, stop and investigate before the next day's orders; do not fix balances by hand in the database.
- Count a few shelves every day (blind counts) so the whole store is counted every few weeks.

## 8. When something goes wrong

- **API or worker down:** `systemctl status` and `journalctl -u dark-store-api`; restart. Orders cannot be lost by a restart: every change is one database transaction, and retries are safe because each write carries an idempotency key.
- **A bad upgrade:** check out the previous release, rebuild and restart. Migrations only add things, so the older code runs against the newer database. If a migration itself is wrong, restore last night's backup into staging first and decide from there.
- **Stock looks wrong on a shelf:** count the shelf in the app. A difference over 2 units or ₹1,000 goes to the Store Manager for approval; never edit stock in the database.
