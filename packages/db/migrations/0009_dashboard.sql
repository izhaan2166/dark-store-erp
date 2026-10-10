ALTER TABLE "store_settings" DROP CONSTRAINT "store_settings_non_negative";--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "expiry_alert_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_non_negative" CHECK (
      "store_settings"."shortage_escalation_minutes" > 0
      AND "store_settings"."sell_by_cutoff_days" >= 0
      AND "store_settings"."count_variance_qty_threshold" >= 0
      AND "store_settings"."count_variance_value_threshold_paise" >= 0
      AND "store_settings"."receiving_variance_pct" >= 0
      AND "store_settings"."expiry_alert_days" >= 0);