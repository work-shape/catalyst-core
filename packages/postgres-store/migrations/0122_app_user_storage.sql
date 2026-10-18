CREATE TABLE "app_user_storage" (
	"client_instance_id" text NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"values" jsonb NOT NULL,
	CONSTRAINT "app_user_storage_client_instance_id_app_id_user_id_pk" PRIMARY KEY("client_instance_id","app_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app_user_storage" ADD CONSTRAINT "app_user_storage_app_id_config_assets_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_storage" ADD CONSTRAINT "app_user_storage_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;