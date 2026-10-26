CREATE TABLE "capability_records" (
	"client_instance_id" text NOT NULL,
	"capability" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"key" text,
	"status" text NOT NULL,
	"document" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "capability_records_pk" PRIMARY KEY("client_instance_id","capability","kind","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "capability_records_key_idx" ON "capability_records" USING btree ("client_instance_id","capability","kind","key") WHERE "capability_records"."key" is not null;--> statement-breakpoint
CREATE INDEX "capability_records_status_idx" ON "capability_records" USING btree ("client_instance_id","capability","kind","status","expires_at");--> statement-breakpoint
CREATE INDEX "capability_records_expiry_idx" ON "capability_records" USING btree ("client_instance_id","capability","expires_at");