ALTER TYPE "public"."shortage_source" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "order_item_shortages" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_item_shortages_open_idx" ON "order_item_shortages" USING btree ("created_at") WHERE "order_item_shortages"."status" = 'open' AND "order_item_shortages"."escalated_at" IS NULL;--> statement-breakpoint
INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('00000000-0000-0000-0000-000000000001', 'system@dark-store.invalid', 'System', NULL) ON CONFLICT DO NOTHING;
