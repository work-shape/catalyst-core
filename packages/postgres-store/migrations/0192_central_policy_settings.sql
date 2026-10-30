-- The admin's central policy (OP-2): two new tables, empty, so every call keeps the policy of
-- its defaults until an admin sets a value. The foreign key locks collaboration_workspaces
-- briefly; a busy one fails the migration instead of holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "always_allow_locks" (
	"client_instance_id" text NOT NULL,
	"operation" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "always_allow_locks_client_instance_id_operation_pk" PRIMARY KEY("client_instance_id","operation")
);
--> statement-breakpoint
CREATE TABLE "central_policy_settings" (
	"client_instance_id" text NOT NULL,
	"operation" text NOT NULL,
	"workspace_id" text,
	"asset_kind" text,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "central_policy_settings_scope_unique" UNIQUE NULLS NOT DISTINCT("client_instance_id","operation","workspace_id","asset_kind"),
	CONSTRAINT "central_policy_settings_value_check" CHECK ("central_policy_settings"."value" in ('allow', 'confirm', 'approval', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "central_policy_settings" ADD CONSTRAINT "central_policy_settings_workspace_id_collaboration_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE cascade ON UPDATE no action;