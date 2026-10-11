CREATE TABLE "connection_state" (
	"connection_asset_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"health" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error_code" text,
	"catalog" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_state_health_check" CHECK ("connection_state"."health" in ('unknown', 'ok', 'failed', 'needs_configuration', 'secret_unreadable'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"handle" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"connection_asset_id" text NOT NULL,
	"subject" text NOT NULL,
	"version" integer NOT NULL,
	"key_id" text NOT NULL,
	"nonce" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secrets_nonce_length_check" CHECK (octet_length("secrets"."nonce") = 12),
	CONSTRAINT "secrets_version_check" CHECK ("secrets"."version" >= 1),
	CONSTRAINT "secrets_source_check" CHECK ("secrets"."source" in ('bootstrap', 'runtime'))
);
--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_connection_asset_id_config_assets_id_fk" FOREIGN KEY ("connection_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_connection_asset_id_config_assets_id_fk" FOREIGN KEY ("connection_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_state_client_idx" ON "connection_state" USING btree ("client_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_connection_subject_idx" ON "secrets" USING btree ("connection_asset_id","subject");--> statement-breakpoint
CREATE INDEX "secrets_client_idx" ON "secrets" USING btree ("client_instance_id");