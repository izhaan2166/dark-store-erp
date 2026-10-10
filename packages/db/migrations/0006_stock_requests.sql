CREATE TYPE "public"."stock_request_kind" AS ENUM('release', 'write_off');--> statement-breakpoint
CREATE TYPE "public"."stock_request_status" AS ENUM('pending_approval', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "stock_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "stock_request_kind" NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"from_location_id" uuid NOT NULL,
	"from_status" "stock_status" NOT NULL,
	"to_location_id" uuid,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "stock_request_status" DEFAULT 'pending_approval' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "stock_requests_quantity_positive" CHECK ("stock_requests"."quantity" > 0),
	CONSTRAINT "stock_requests_shape" CHECK (("stock_requests"."kind" = 'release' AND "stock_requests"."to_location_id" IS NOT NULL AND "stock_requests"."from_status" <> 'available')
        OR ("stock_requests"."kind" = 'write_off' AND "stock_requests"."to_location_id" IS NULL)),
	CONSTRAINT "stock_requests_decision_recorded" CHECK ("stock_requests"."status" = 'pending_approval'
        OR ("stock_requests"."decided_by" IS NOT NULL AND "stock_requests"."decision_reason" IS NOT NULL AND "stock_requests"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_requests_store_status_idx" ON "stock_requests" USING btree ("store_id","status");