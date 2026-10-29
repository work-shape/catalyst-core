CREATE TABLE "data_store_test_copies" (
	"store_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"database_name" text NOT NULL,
	"migrations" jsonb NOT NULL,
	"seed_sha256" text NOT NULL,
	"seed_files" integer NOT NULL,
	"size_bytes" bigint,
	"built_at" timestamp with time zone NOT NULL,
	"built_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_store_test_copies" ADD CONSTRAINT "data_store_test_copies_store_id_data_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."data_stores"("id") ON DELETE cascade ON UPDATE no action;