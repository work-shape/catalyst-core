CREATE TABLE "data_stores" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"database_name" text NOT NULL,
	"app_role" text NOT NULL,
	"migration_role" text NOT NULL,
	"level" integer NOT NULL,
	"migrations" jsonb NOT NULL,
	"target_revision" integer NOT NULL,
	"size_limit_bytes" bigint NOT NULL,
	"size_bytes" bigint,
	"size_measured_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"conditions" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "data_stores_status_check" CHECK ("data_stores"."status" in ('provisioning', 'ready', 'retired')),
	CONSTRAINT "data_stores_level_check" CHECK ("data_stores"."level" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "data_stores_client_name_idx" ON "data_stores" USING btree ("client_instance_id","name");