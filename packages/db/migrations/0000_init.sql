CREATE TYPE "public"."location_kind" AS ENUM('zone', 'rack', 'shelf', 'bin');--> statement-breakpoint
CREATE TYPE "public"."location_purpose" AS ENUM('storage', 'receiving', 'packing', 'quarantine');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('opening_balance', 'receipt', 'putaway', 'transfer', 'pick', 'return_to_stock', 'handover', 'status_change', 'adjustment', 'write_off', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('accepted', 'picking', 'packing', 'ready_for_handover', 'handed_over', 'cancel_pending', 'cancelled', 'exception');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."shortage_source" AS ENUM('reservation', 'short_pick', 'quarantine');--> statement-breakpoint
CREATE TYPE "public"."shortage_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."stock_status" AS ENUM('receiving', 'available', 'quarantined', 'damaged', 'expired');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"expiry_date" date,
	CONSTRAINT "batches_product_lot" UNIQUE("product_id","lot_code")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"store_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("store_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"status" "stock_status" NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_bucket" UNIQUE NULLS NOT DISTINCT("store_id","location_id","product_id","batch_id","status"),
	CONSTRAINT "inventory_balances_on_hand_non_negative" CHECK ("inventory_balances"."on_hand" >= 0),
	CONSTRAINT "inventory_balances_reserved_within_on_hand" CHECK ("inventory_balances"."reserved" >= 0 AND "inventory_balances"."reserved" <= "inventory_balances"."on_hand"),
	CONSTRAINT "inventory_balances_reserved_only_available" CHECK ("inventory_balances"."status" = 'available' OR "inventory_balances"."reserved" = 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"from_location_id" uuid,
	"from_status" "stock_status",
	"to_location_id" uuid,
	"to_status" "stock_status",
	"quantity" integer NOT NULL,
	"movement_type" "movement_type" NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text,
	"reverses_movement_id" bigint,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_quantity_positive" CHECK ("inventory_movements"."quantity" > 0),
	CONSTRAINT "inventory_movements_has_side" CHECK (("inventory_movements"."from_location_id" IS NOT NULL AND "inventory_movements"."from_status" IS NOT NULL)
        OR ("inventory_movements"."to_location_id" IS NOT NULL AND "inventory_movements"."to_status" IS NOT NULL)),
	CONSTRAINT "inventory_movements_sides_complete" CHECK (("inventory_movements"."from_location_id" IS NULL) = ("inventory_movements"."from_status" IS NULL)
        AND ("inventory_movements"."to_location_id" IS NULL) = ("inventory_movements"."to_status" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"purpose" "location_purpose" DEFAULT 'storage' NOT NULL,
	"allocatable" boolean DEFAULT false NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "locations_store_code" UNIQUE("store_id","code"),
	CONSTRAINT "locations_allocatable_storage_only" CHECK (NOT "locations"."allocatable" OR "locations"."purpose" = 'storage')
);
--> statement-breakpoint
CREATE TABLE "order_item_shortages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"source" "shortage_source" NOT NULL,
	"quantity" integer NOT NULL,
	"status" "shortage_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_shortages_quantity_positive" CHECK ("order_item_shortages"."quantity" > 0),
	CONSTRAINT "order_item_shortages_resolution_complete" CHECK ("order_item_shortages"."status" = 'open' OR ("order_item_shortages"."resolution" IS NOT NULL AND "order_item_shortages"."resolved_by" IS NOT NULL AND "order_item_shortages"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"requested_qty" integer NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"picked_qty" integer DEFAULT 0 NOT NULL,
	"fulfilled_qty" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_items_order_line" UNIQUE("order_id","line_no"),
	CONSTRAINT "order_items_requested_positive" CHECK ("order_items"."requested_qty" > 0),
	CONSTRAINT "order_items_quantities_ordered" CHECK ("order_items"."reserved_qty" >= 0
        AND "order_items"."reserved_qty" <= "order_items"."requested_qty"
        AND 0 <= "order_items"."fulfilled_qty"
        AND "order_items"."fulfilled_qty" <= "order_items"."picked_qty"
        AND "order_items"."picked_qty" <= "order_items"."requested_qty")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"status" "order_status" DEFAULT 'accepted' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_store_external_ref" UNIQUE("store_id","external_ref")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"barcode" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"unit_of_measure" text DEFAULT 'each' NOT NULL,
	"batch_tracked" boolean DEFAULT false NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"avg_unit_cost_paise" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_cost_non_negative" CHECK ("products"."avg_unit_cost_paise" IS NULL OR "products"."avg_unit_cost_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"balance_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"consumed_qty" integer DEFAULT 0 NOT NULL,
	"released_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_allocations_quantities" CHECK ("reservation_allocations"."quantity" > 0
        AND "reservation_allocations"."consumed_qty" >= 0
        AND "reservation_allocations"."released_qty" >= 0
        AND "reservation_allocations"."consumed_qty" + "reservation_allocations"."released_qty" <= "reservation_allocations"."quantity")
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "stock_reservations_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "store_settings" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"shortage_escalation_minutes" integer DEFAULT 15 NOT NULL,
	"auto_cancel_enabled" boolean DEFAULT false NOT NULL,
	"sell_by_cutoff_days" integer DEFAULT 0 NOT NULL,
	"count_variance_qty_threshold" integer DEFAULT 2 NOT NULL,
	"count_variance_value_threshold_paise" integer DEFAULT 100000 NOT NULL,
	"receiving_variance_pct" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_settings_non_negative" CHECK (
      "store_settings"."shortage_escalation_minutes" > 0
      AND "store_settings"."sell_by_cutoff_days" >= 0
      AND "store_settings"."count_variance_qty_threshold" >= 0
      AND "store_settings"."count_variance_value_threshold_paise" >= 0
      AND "store_settings"."receiving_variance_pct" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shortages" ADD CONSTRAINT "order_item_shortages_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shortages" ADD CONSTRAINT "order_item_shortages_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_reservation_id_stock_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."stock_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_balance_id_inventory_balances_id_fk" FOREIGN KEY ("balance_id") REFERENCES "public"."inventory_balances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_balances_product_idx" ON "inventory_balances" USING btree ("store_id","product_id","status");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_product_idx" ON "inventory_movements" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unprocessed_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservation_allocations_balance_idx" ON "reservation_allocations" USING btree ("balance_id");--> statement-breakpoint
CREATE INDEX "reservation_allocations_item_idx" ON "reservation_allocations" USING btree ("order_item_id");