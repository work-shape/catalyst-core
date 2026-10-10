CREATE TABLE "infrastructure_check_state" (
	"client_instance_id" text PRIMARY KEY NOT NULL,
	"outcomes" jsonb NOT NULL,
	"manual_check_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
