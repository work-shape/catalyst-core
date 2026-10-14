-- Expand: a key of `api_credentials` belongs to a service principal or, as a personal API
-- key, to a user. The owner constraints are added without a scan of the table; the next
-- migration validates them and the one after adds the list indexes concurrently. A release
-- before this one writes only keys of service principals, which pass both.
CREATE TABLE "api_connect_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"client_label" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"owner_user_id" text,
	"key_name" text,
	"key_scopes" jsonb,
	"key_expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"credential_id" text,
	CONSTRAINT "api_connect_codes_approval_check" CHECK (("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."owner_user_id" is null) and ("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."key_scopes" is null) and ("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."key_expires_at" is null) and ("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."key_name" is null))
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ALTER COLUMN "service_principal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "api_connect_codes" ADD CONSTRAINT "api_connect_codes_client_owner_fk" FOREIGN KEY ("client_instance_id","owner_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_connect_codes_device_code_idx" ON "api_connect_codes" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_connect_codes_client_user_code_idx" ON "api_connect_codes" USING btree ("client_instance_id","user_code_hash");--> statement-breakpoint
CREATE INDEX "api_connect_codes_expires_idx" ON "api_connect_codes" USING btree ("client_instance_id","expires_at");--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_client_owner_fk" FOREIGN KEY ("client_instance_id","owner_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_one_owner_check" CHECK (("api_credentials"."service_principal_id" is null) <> ("api_credentials"."owner_user_id" is null)) NOT VALID;
