import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const recordStatus = pgEnum("record_status", ["active", "inactive"]);

export const userRole = pgEnum("user_role", [
  "super_admin",
  "store_manager",
  "inventory_manager",
  "receiving_staff",
  "picker",
  "packer",
  "auditor",
]);

export const stockStatus = pgEnum("stock_status", [
  "receiving",
  "available",
  "quarantined",
  "damaged",
  "expired",
]);

/** What a location is used for. Only `storage` locations can be allocatable. */
export const locationPurpose = pgEnum("location_purpose", [
  "storage",
  "receiving",
  "packing",
  "quarantine",
]);

export const locationKind = pgEnum("location_kind", ["zone", "rack", "shelf", "bin"]);

export const movementType = pgEnum("movement_type", [
  "opening_balance",
  "receipt",
  "putaway",
  "transfer",
  "pick",
  "return_to_stock",
  "handover",
  "status_change",
  "adjustment",
  "write_off",
  "reversal",
]);

export const orderStatus = pgEnum("order_status", [
  "accepted",
  "picking",
  "packing",
  "ready_for_handover",
  "handed_over",
  "cancel_pending",
  "cancelled",
  "exception",
]);

export const reservationStatus = pgEnum("reservation_status", ["active", "closed"]);

export const shortageSource = pgEnum("shortage_source", ["reservation", "short_pick", "quarantine"]);

export const shortageStatus = pgEnum("shortage_status", ["open", "resolved"]);

export const purchaseOrderStatus = pgEnum("purchase_order_status", ["open", "received", "cancelled"]);

export const goodsReceiptStatus = pgEnum("goods_receipt_status", ["pending_approval", "posted", "cancelled"]);

export const stockCountStatus = pgEnum("stock_count_status", ["pending_approval", "posted", "rejected"]);

export const receivingDiscrepancyKind = pgEnum("receiving_discrepancy_kind", [
  "short",
  "excess",
  "unordered",
  "damaged",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Stores, users, settings
// ---------------------------------------------------------------------------

export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  status: recordStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-store operational settings. Approval thresholds are editable defaults. */
export const storeSettings = pgTable(
  "store_settings",
  {
    storeId: uuid("store_id")
      .primaryKey()
      .references(() => stores.id),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    shortageEscalationMinutes: integer("shortage_escalation_minutes").notNull().default(15),
    autoCancelEnabled: boolean("auto_cancel_enabled").notNull().default(false),
    /** Batches expiring within this many days are not allocated to new orders. */
    sellByCutoffDays: integer("sell_by_cutoff_days").notNull().default(0),
    countVarianceQtyThreshold: integer("count_variance_qty_threshold").notNull().default(2),
    countVarianceValueThresholdPaise: integer("count_variance_value_threshold_paise")
      .notNull()
      .default(100_000),
    receivingVariancePct: integer("receiving_variance_pct").notNull().default(5),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("store_settings_non_negative", sql`
      ${t.shortageEscalationMinutes} > 0
      AND ${t.sellByCutoffDays} >= 0
      AND ${t.countVarianceQtyThreshold} >= 0
      AND ${t.countVarianceValueThresholdPaise} >= 0
      AND ${t.receivingVariancePct} >= 0`),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  status: recordStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Roles are granted per store; one person may hold several. */
export const userStoreRoles = pgTable(
  "user_store_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    role: userRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "user_store_roles_pk", columns: [t.userId, t.storeId, t.role] })],
);

/** Login sessions. Only a SHA-256 hash of the bearer token is stored. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Catalogue and locations
// ---------------------------------------------------------------------------

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    parentId: uuid("parent_id"),
    code: text("code").notNull(),
    kind: locationKind("kind").notNull(),
    purpose: locationPurpose("purpose").notNull().default("storage"),
    /** Stock here can be reserved for orders. Never true for packing, receiving or quarantine. */
    allocatable: boolean("allocatable").notNull().default(false),
    status: recordStatus("status").notNull().default("active"),
  },
  (t) => [
    unique("locations_store_code").on(t.storeId, t.code),
    check("locations_allocatable_storage_only", sql`NOT ${t.allocatable} OR ${t.purpose} = 'storage'`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    unitOfMeasure: text("unit_of_measure").notNull().default("each"),
    batchTracked: boolean("batch_tracked").notNull().default(false),
    status: recordStatus("status").notNull().default("active"),
    /** Moving weighted-average unit cost, updated on accepted GRN lines. Null until first receipt. */
    avgUnitCostPaise: integer("avg_unit_cost_paise"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("products_cost_non_negative", sql`${t.avgUnitCostPaise} IS NULL OR ${t.avgUnitCostPaise} >= 0`)],
);

export const productBarcodes = pgTable("product_barcodes", {
  barcode: text("barcode").primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
});

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    lotCode: text("lot_code").notNull(),
    expiryDate: date("expiry_date"),
  },
  (t) => [unique("batches_product_lot").on(t.productId, t.lotCode)],
);

// ---------------------------------------------------------------------------
// Inventory ledger
// ---------------------------------------------------------------------------

/**
 * Current operational balance per (store, location, product, batch, status).
 * Maintained in the same transaction as every movement; `reserved` mirrors the
 * open quantity of active reservation allocations against this row.
 */
export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    batchId: uuid("batch_id").references(() => batches.id),
    status: stockStatus("status").notNull(),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("inventory_balances_bucket")
      .on(t.storeId, t.locationId, t.productId, t.batchId, t.status)
      .nullsNotDistinct(),
    check("inventory_balances_on_hand_non_negative", sql`${t.onHand} >= 0`),
    check("inventory_balances_reserved_within_on_hand", sql`${t.reserved} >= 0 AND ${t.reserved} <= ${t.onHand}`),
    check("inventory_balances_reserved_only_available", sql`${t.status} = 'available' OR ${t.reserved} = 0`),
    index("inventory_balances_product_idx").on(t.storeId, t.productId, t.status),
  ],
);

/** Append-only history of physical stock changes. UPDATE and DELETE are blocked by a trigger. */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    batchId: uuid("batch_id").references(() => batches.id),
    fromLocationId: uuid("from_location_id").references(() => locations.id),
    fromStatus: stockStatus("from_status"),
    toLocationId: uuid("to_location_id").references(() => locations.id),
    toStatus: stockStatus("to_status"),
    quantity: integer("quantity").notNull(),
    movementType: movementType("movement_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    reason: text("reason"),
    reversesMovementId: bigint("reverses_movement_id", { mode: "number" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inventory_movements_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "inventory_movements_has_side",
      sql`(${t.fromLocationId} IS NOT NULL AND ${t.fromStatus} IS NOT NULL)
        OR (${t.toLocationId} IS NOT NULL AND ${t.toStatus} IS NOT NULL)`,
    ),
    check(
      "inventory_movements_sides_complete",
      sql`(${t.fromLocationId} IS NULL) = (${t.fromStatus} IS NULL)
        AND (${t.toLocationId} IS NULL) = (${t.toStatus} IS NULL)`,
    ),
    index("inventory_movements_source_idx").on(t.sourceType, t.sourceId),
    index("inventory_movements_product_idx").on(t.storeId, t.productId),
  ],
);

// ---------------------------------------------------------------------------
// Orders and reservations
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    externalRef: text("external_ref").notNull(),
    status: orderStatus("status").notNull().default("accepted"),
    /** Where this order's picked units wait; set by the first pick. */
    packingLocationId: uuid("packing_location_id").references(() => locations.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("orders_store_external_ref").on(t.storeId, t.externalRef)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    lineNo: integer("line_no").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    /** Quantity the customer asked for. Never changes. */
    requestedQty: integer("requested_qty").notNull(),
    /** Units covered by open reservation allocations on this line. */
    reservedQty: integer("reserved_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    fulfilledQty: integer("fulfilled_qty").notNull().default(0),
  },
  (t) => [
    unique("order_items_order_line").on(t.orderId, t.lineNo),
    check("order_items_requested_positive", sql`${t.requestedQty} > 0`),
    check(
      "order_items_quantities_ordered",
      sql`${t.reservedQty} >= 0
        AND ${t.reservedQty} <= ${t.requestedQty}
        AND 0 <= ${t.fulfilledQty}
        AND ${t.fulfilledQty} <= ${t.pickedQty}
        AND ${t.pickedQty} <= ${t.requestedQty}`,
    ),
  ],
);

export const stockReservations = pgTable("stock_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  status: reservationStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

/**
 * One allocation of a reservation to one balance row. Open quantity is
 * quantity - consumed_qty - released_qty, and the sum of open quantities per
 * balance row must equal that row's `reserved`.
 */
export const reservationAllocations = pgTable(
  "reservation_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => stockReservations.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    balanceId: bigint("balance_id", { mode: "number" })
      .notNull()
      .references(() => inventoryBalances.id),
    quantity: integer("quantity").notNull(),
    consumedQty: integer("consumed_qty").notNull().default(0),
    releasedQty: integer("released_qty").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "reservation_allocations_quantities",
      sql`${t.quantity} > 0
        AND ${t.consumedQty} >= 0
        AND ${t.releasedQty} >= 0
        AND ${t.consumedQty} + ${t.releasedQty} <= ${t.quantity}`,
    ),
    index("reservation_allocations_balance_idx").on(t.balanceId),
    index("reservation_allocations_item_idx").on(t.orderItemId),
  ],
);

export const orderItemShortages = pgTable(
  "order_item_shortages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    source: shortageSource("source").notNull(),
    quantity: integer("quantity").notNull(),
    status: shortageStatus("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("order_item_shortages_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "order_item_shortages_resolution_complete",
      sql`${t.status} = 'open' OR (${t.resolution} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Cross-cutting: idempotency, outbox, audit
// ---------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "idempotency_keys_pk", columns: [t.storeId, t.scope, t.key] })],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("outbox_events_unprocessed_idx").on(t.id).where(sql`${t.processedAt} IS NULL`)],
);

export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  storeId: uuid("store_id").references(() => stores.id),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Purchasing and receiving
// ---------------------------------------------------------------------------

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: recordStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("suppliers_store_code").on(t.storeId, t.code)],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    poNumber: text("po_number").notNull(),
    /** `received` once every line's accepted quantity reaches what was ordered. */
    status: purchaseOrderStatus("status").notNull().default("open"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("purchase_orders_store_number").on(t.storeId, t.poNumber)],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    lineNo: integer("line_no").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    orderedQty: integer("ordered_qty").notNull(),
    /** Accepted units across posted receipts. Can exceed ordered after an approved excess. */
    receivedQty: integer("received_qty").notNull().default(0),
    unitCostPaise: integer("unit_cost_paise").notNull(),
  },
  (t) => [
    unique("purchase_order_lines_po_line").on(t.purchaseOrderId, t.lineNo),
    unique("purchase_order_lines_po_product").on(t.purchaseOrderId, t.productId),
    check(
      "purchase_order_lines_quantities",
      sql`${t.orderedQty} > 0 AND ${t.receivedQty} >= 0 AND ${t.unitCostPaise} >= 0`,
    ),
  ],
);

/** A Goods Received Note. Stock moves only when it is posted. */
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    /** Null for an ad hoc receipt, which always needs approval. */
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    receivingLocationId: uuid("receiving_location_id")
      .notNull()
      .references(() => locations.id),
    status: goodsReceiptStatus("status").notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [
    index("goods_receipts_store_status_idx").on(t.storeId, t.status),
    check(
      "goods_receipts_decision_recorded",
      sql`${t.status} = 'posted' AND ${t.decidedBy} IS NULL
        OR ${t.status} = 'pending_approval'
        OR ${t.decidedBy} IS NOT NULL AND ${t.decisionReason} IS NOT NULL`,
    ),
  ],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id),
    lineNo: integer("line_no").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").references(() => purchaseOrderLines.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    batchId: uuid("batch_id").references(() => batches.id),
    /** Outstanding quantity on the PO line when the receipt was recorded; 0 if unordered. */
    expectedQty: integer("expected_qty").notNull(),
    acceptedQty: integer("accepted_qty").notNull(),
    damagedQty: integer("damaged_qty").notNull().default(0),
    rejectedQty: integer("rejected_qty").notNull().default(0),
    unitCostPaise: integer("unit_cost_paise").notNull(),
    needsApproval: boolean("needs_approval").notNull(),
  },
  (t) => [
    unique("goods_receipt_lines_grn_line").on(t.goodsReceiptId, t.lineNo),
    check(
      "goods_receipt_lines_quantities",
      sql`${t.expectedQty} >= 0 AND ${t.acceptedQty} >= 0 AND ${t.damagedQty} >= 0
        AND ${t.rejectedQty} >= 0 AND ${t.unitCostPaise} >= 0
        AND ${t.acceptedQty} + ${t.damagedQty} + ${t.rejectedQty} > 0`,
    ),
  ],
);

export const receivingDiscrepancies = pgTable(
  "receiving_discrepancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goodsReceiptLineId: uuid("goods_receipt_line_id")
      .notNull()
      .references(() => goodsReceiptLines.id),
    kind: receivingDiscrepancyKind("kind").notNull(),
    quantity: integer("quantity").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("receiving_discrepancies_quantity_positive", sql`${t.quantity} > 0`)],
);

// ---------------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------------

/** A physical count of one location. Stock changes only when it is posted. */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    status: stockCountStatus("status").notNull(),
    countedBy: uuid("counted_by")
      .notNull()
      .references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [
    index("stock_counts_store_status_idx").on(t.storeId, t.status),
    check(
      "stock_counts_decision_recorded",
      sql`${t.status} = 'pending_approval'
        OR ${t.status} = 'posted' AND ${t.decidedBy} IS NULL
        OR ${t.decidedBy} IS NOT NULL AND ${t.decisionReason} IS NOT NULL`,
    ),
  ],
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references(() => stockCounts.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    batchId: uuid("batch_id").references(() => batches.id),
    /** Book units in the location (available plus blocked) when the count was submitted. */
    bookQty: integer("book_qty").notNull(),
    /** Of the book units, how many were blocked as `quarantined` (e.g. after a short pick). */
    blockedQty: integer("blocked_qty").notNull(),
    countedQty: integer("counted_qty").notNull(),
    /** Moving average cost when the count was submitted; null if the product has none yet. */
    unitCostPaise: integer("unit_cost_paise"),
    needsApproval: boolean("needs_approval").notNull(),
  },
  (t) => [
    unique("stock_count_lines_item").on(t.stockCountId, t.productId, t.batchId).nullsNotDistinct(),
    check(
      "stock_count_lines_quantities",
      sql`${t.bookQty} >= 0 AND ${t.blockedQty} >= 0 AND ${t.blockedQty} <= ${t.bookQty} AND ${t.countedQty} >= 0`,
    ),
  ],
);
