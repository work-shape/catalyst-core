-- A new table. Its foreign keys lock the tables they reference briefly; a busy one fails the
-- migration instead of holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "draft_host_allowances" (
	"client_instance_id" text NOT NULL,
	"app_id" text,
	"page_id" text,
	"user_id" text NOT NULL,
	"host" text NOT NULL,
	"file_set_number" integer NOT NULL,
	"allowed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "draft_host_allowances_owner_check" CHECK (("draft_host_allowances"."app_id" is null) <> ("draft_host_allowances"."page_id" is null))
);
--> statement-breakpoint
ALTER TABLE "draft_host_allowances" ADD CONSTRAINT "draft_host_allowances_app_id_config_assets_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_host_allowances" ADD CONSTRAINT "draft_host_allowances_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_host_allowances" ADD CONSTRAINT "draft_host_allowances_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_host_allowances_app_idx" ON "draft_host_allowances" USING btree ("app_id","user_id","host");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_host_allowances_page_idx" ON "draft_host_allowances" USING btree ("page_id","user_id","host");--> statement-breakpoint
CREATE INDEX "draft_host_allowances_user_idx" ON "draft_host_allowances" USING btree ("user_id");