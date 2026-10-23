-- A person's own confirmation settings (OP-6): a new table, empty, so every call keeps the
-- policy the admin set until a person sets a value. Its foreign key and the new nullable column
-- of operation_runs lock their tables briefly; a busy one fails the migration instead of
-- holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "user_operation_settings" (
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_operation_settings_client_instance_id_user_id_operation_pk" PRIMARY KEY("client_instance_id","user_id","operation"),
	CONSTRAINT "user_operation_settings_value_check" CHECK ("user_operation_settings"."value" in ('always_allow', 'ask', 'never'))
);
--> statement-breakpoint
ALTER TABLE "operation_runs" ADD COLUMN "offers_always_allow" boolean;--> statement-breakpoint
ALTER TABLE "user_operation_settings" ADD CONSTRAINT "user_operation_settings_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;