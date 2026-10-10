/**
 * Load test for one store: orders arriving at a steady rate while staff pick,
 * pack and hand them over the way the app does it (one pick per scanned unit),
 * a manager watching the dashboard, and staff looking up products and stock
 * between orders.
 *
 *   Normal: k6 run -e API_URL=http://localhost:3001 loadtest/k6.js
 *   Stress: k6 run -e API_URL=… -e ORDERS_PER_HOUR=240 -e STAFF=30 loadtest/k6.js
 *
 * Seed first with `pnpm loadtest:seed`, which writes loadtest/data.json.
 * Passes when every screen's p95 is under 2 seconds and no request fails
 * with a server error. Run `pnpm reconcile --store <code>` afterwards.
 */
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const API = __ENV.API_URL || "http://localhost:3001";
const ORDERS_PER_HOUR = Number(__ENV.ORDERS_PER_HOUR || 120);
const STAFF = Number(__ENV.STAFF || 20);
const DURATION = __ENV.DURATION || "15m";

const seed = JSON.parse(open("./data.json"));
const products = new SharedArray("products", () => seed.products);
const popular = new SharedArray("popular", () => seed.products.filter((p) => p.popular));
const store = seed.storeId;

/** The screens a person waits on; each must keep its p95 under 2 seconds. */
const SCREENS = [
  "order-entry",
  "order-queue",
  "start-picking",
  "pick-list",
  "scan",
  "pick",
  "complete-picking",
  "pack",
  "handover",
  "dashboard",
  "product-search",
  "stock-lookup",
];

export const options = {
  setupTimeout: "2m",
  scenarios: {
    orders: {
      executor: "constant-arrival-rate",
      exec: "placeOrder",
      rate: ORDERS_PER_HOUR,
      timeUnit: "1h",
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
    staff: { executor: "constant-vus", exec: "staffShift", vus: STAFF, duration: DURATION },
    manager: { executor: "constant-vus", exec: "watchDashboard", vus: 1, duration: DURATION },
  },
  thresholds: Object.fromEntries([
    ...SCREENS.map((s) => [`screen_time{screen:${s}}`, ["p(95)<2000"]]),
    ["server_errors", ["count<1"]],
    ["checks", ["rate>0.99"]],
  ]),
  summaryTrendStats: ["med", "p(95)", "max", "count"],
};

const screenTime = new Trend("screen_time", true);
const serverErrors = new Counter("server_errors");
const handedOver = new Counter("orders_handed_over");
const raceLost = new Counter("orders_taken_by_someone_else");

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
const pause = (min, max) => sleep(min + Math.random() * (max - min));
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

let barcodes;
/** The barcode a picker would scan for a product. */
function barcodeOf(productId) {
  if (!barcodes) {
    barcodes = new Map();
    for (const p of products) barcodes.set(p.productId, p.barcode);
  }
  return barcodes.get(productId);
}

/** One request from a screen. Statuses in `ok` are expected answers, not failures. */
function call(token, method, path, screen, body, ok = [200, 201]) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (method !== "GET") headers["Idempotency-Key"] = uuid();
  const res = http.request(method, `${API}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers,
    tags: { screen, name: screen },
    responseCallback: http.expectedStatuses(...ok),
  });
  screenTime.add(res.timings.duration, { screen });
  if (res.status === 0 || res.status >= 500) {
    serverErrors.add(1, { screen });
    console.error(`${screen}: ${method} ${path} -> ${res.status} ${res.body}`);
  }
  check(res, { [`${screen} answered`]: (r) => ok.includes(r.status) });
  return res;
}

function login(email) {
  const res = http.post(`${API}/auth/login`, JSON.stringify({ email, password: seed.password }), {
    headers: { "Content-Type": "application/json" },
  });
  if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status} ${res.body}`);
  return res.json("token");
}

export function setup() {
  return { manager: login(seed.manager), staff: seed.staff.slice(0, STAFF).map(login) };
}

/** A manager keys in an order: looks up each item, then saves it. */
export function placeOrder(tokens) {
  const count = 1 + Math.floor(Math.random() * 5);
  const chosen = new Map();
  while (chosen.size < count) {
    const p = Math.random() < 0.8 ? pickOne(popular) : pickOne(products);
    chosen.set(p.productId, p);
  }
  for (const p of chosen.values()) call(tokens.manager, "GET", `/stores/${store}/barcodes/${p.barcode}`, "scan");
  const res = call(tokens.manager, "POST", `/stores/${store}/orders`, "order-entry", {
    externalRef: `LT-${__VU}-${__ITER}-${Date.now()}`,
    lines: [...chosen.keys()].map((productId) => ({ productId, quantity: 1 + Math.floor(Math.random() * 3) })),
  });
  check(res, { "order fully reserved": (r) => r.status !== 201 || r.json("fullyReserved") === true });
}

/** One staff member's loop: take the next order and see it through, or do stock work while the queue is empty. */
export function staffShift(tokens) {
  const token = tokens.staff[(__VU - 1) % tokens.staff.length];
  const queue = call(token, "GET", `/stores/${store}/orders?status=accepted`, "order-queue");
  const waiting = queue.status === 200 ? queue.json() : [];
  if (!Array.isArray(waiting) || waiting.length === 0) {
    lookAround(token);
    pause(10, 15);
    return;
  }
  // Oldest first, with a little spread so staff do not all grab the same order.
  const order = waiting[Math.floor(Math.random() * Math.min(3, waiting.length))];
  const base = `/stores/${store}/orders/${order.orderId}`;
  pause(1, 3);
  const started = call(token, "POST", `${base}/start-picking`, "start-picking", undefined, [200, 409]);
  if (started.status === 409) {
    raceLost.add(1);
    return;
  }

  let view = call(token, "GET", `${base}/fulfilment`, "pick-list").json();
  const known = new Map();
  for (const line of view.lines) {
    for (const task of line.tasks) {
      const barcode = barcodeOf(line.productId);
      for (let unit = 0; unit < task.quantity; unit++) {
        pause(2, 4); // walk to the bin and scan
        if (!known.has(barcode)) {
          call(token, "GET", `/stores/${store}/barcodes/${barcode}`, "scan");
          known.set(barcode, true);
        }
        call(token, "POST", `${base}/picks`, "pick", {
          orderItemId: line.orderItemId,
          locationId: task.locationId,
          barcode,
          quantity: 1,
        });
      }
    }
  }
  pause(1, 2);
  call(token, "POST", `${base}/complete-picking`, "complete-picking");

  view = call(token, "GET", `${base}/fulfilment`, "pick-list").json();
  pause(5, 10); // count the items into the bag
  call(token, "POST", `${base}/pack`, "pack", {
    lines: view.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.pickedQty })),
  });
  pause(2, 5);
  const done = call(token, "POST", `${base}/handover`, "handover");
  if (done.status === 200) handedOver.add(1);
}

/** Between orders staff search the catalogue and check stock, as during putaway and counts. */
function lookAround(token) {
  const p = pickOne(products);
  const q = `Load item ${1 + Math.floor(Math.random() * products.length)}`;
  call(token, "GET", `/stores/${store}/products?q=${encodeURIComponent(q)}&limit=20`, "product-search");
  call(token, "GET", `/stores/${store}/inventory/products/${p.productId}`, "stock-lookup");
}

/** The manager keeps the Today screen open; it refreshes every minute. */
export function watchDashboard(tokens) {
  call(tokens.manager, "GET", `/stores/${store}/dashboard`, "dashboard");
  call(tokens.manager, "GET", `/stores/${store}/dashboard/out-of-stock`, "dashboard");
  sleep(60);
}
