CREATE TABLE "usage_spend_limits" (
	"client_instance_id" text NOT NULL,
	"level" text NOT NULL,
	"user_id" text,
	"collaboration_workspace_id" text,
	"daily_limit_micros" bigint,
	"monthly_limit_micros" bigint,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "usage_spend_limits_target_check" CHECK (("usage_spend_limits"."level" = 'user') = ("usage_spend_limits"."user_id" is not null)
        and ("usage_spend_limits"."level" = 'workspace') = ("usage_spend_limits"."collaboration_workspace_id" is not null)),
	CONSTRAINT "usage_spend_limits_amount_check" CHECK (coalesce("usage_spend_limits"."daily_limit_micros", 0) >= 0 and coalesce("usage_spend_limits"."monthly_limit_micros", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_spend_limits" ADD CONSTRAINT "usage_spend_limits_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_spend_limits" ADD CONSTRAINT "usage_spend_limits_workspace_fk" FOREIGN KEY ("collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_spend_limits_level_idx" ON "usage_spend_limits" USING btree ("client_instance_id","level",coalesce("user_id", "collaboration_workspace_id", ''));