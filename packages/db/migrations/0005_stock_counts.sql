CREATE TYPE "public"."stock_count_status" AS ENUM('pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"book_qty" integer NOT NULL,
	"blocked_qty" integer NOT NULL,
	"counted_qty" integer NOT NULL,
	"unit_cost_paise" integer,
	"needs_approval" boolean NOT NULL,
	CONSTRAINT "stock_count_lines_item" UNIQUE NULLS NOT DISTINCT("stock_count_id","product_id","batch_id"),
	CONSTRAINT "stock_count_lines_quantities" CHECK ("stock_count_lines"."book_qty" >= 0 AND "stock_count_lines"."blocked_qty" >= 0 AND "stock_count_lines"."blocked_qty" <= "stock_count_lines"."book_qty" AND "stock_count_lines"."counted_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "stock_count_status" NOT NULL,
	"counted_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "stock_counts_decision_recorded" CHECK ("stock_counts"."status" = 'pending_approval'
        OR "stock_counts"."status" = 'posted' AND "stock_counts"."decided_by" IS NULL
        OR "stock_counts"."decided_by" IS NOT NULL AND "stock_counts"."decision_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_counts_store_status_idx" ON "stock_counts" USING btree ("store_id","status");