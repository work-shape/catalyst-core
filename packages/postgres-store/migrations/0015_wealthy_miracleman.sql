CREATE TABLE "api_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"service_principal_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "service_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"display_label" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"permission_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_client_instance_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "service_principals_creator_client_check" CHECK (("service_principals"."created_by_user_id" is null and "service_principals"."created_by_client_instance_id" is null) or ("service_principals"."created_by_user_id" is not null and "service_principals"."created_by_client_instance_id" is not null and "service_principals"."created_by_client_instance_id" = "service_principals"."client_instance_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_users_client_id_idx" ON "product_users" USING btree ("client_instance_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_principals_client_id_idx" ON "service_principals" USING btree ("client_instance_id","id");--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_client_principal_fk" FOREIGN KEY ("client_instance_id","service_principal_id") REFERENCES "public"."service_principals"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_principals" ADD CONSTRAINT "service_principals_client_creator_fk" FOREIGN KEY ("created_by_client_instance_id","created_by_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_key_prefix_idx" ON "api_credentials" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_credentials_client_principal_idx" ON "api_credentials" USING btree ("client_instance_id","service_principal_id");--> statement-breakpoint
CREATE INDEX "service_principals_client_label_idx" ON "service_principals" USING btree ("client_instance_id","display_label");
