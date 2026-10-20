SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "connection_source_calls" (
	"lease_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"connection_asset_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"active_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_source_calls" ADD CONSTRAINT "connection_source_calls_connection_asset_id_config_assets_id_fk" FOREIGN KEY ("connection_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_source_calls_connection_idx" ON "connection_source_calls" USING btree ("client_instance_id","connection_asset_id","started_at");--> statement-breakpoint
CREATE INDEX "connection_source_calls_expiry_idx" ON "connection_source_calls" USING btree ("expires_at");