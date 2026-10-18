CREATE TABLE "notice_mail" (
	"notice_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_failure_notices" (
	"root_run_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_revision_publishers" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notice_mail" ADD CONSTRAINT "notice_mail_notice_id_approval_requests_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_mail" ADD CONSTRAINT "notice_mail_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_notices" ADD CONSTRAINT "workflow_failure_notices_root_run_id_workflow_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_publishers" ADD CONSTRAINT "workflow_revision_publishers_revision_id_config_asset_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."config_asset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_mail_due_idx" ON "notice_mail" USING btree ("client_instance_id","due_at","user_id");--> statement-breakpoint
CREATE INDEX "notice_mail_recipient_idx" ON "notice_mail" USING btree ("client_instance_id","user_id","due_at");
--> statement-breakpoint
-- Attribute existing published revisions from their publication events, never their draft author.
INSERT INTO "workflow_revision_publishers" ("revision_id", "client_instance_id", "user_id")
SELECT DISTINCT ON (r.id) r.id, r.client_instance_id, e.actor->>'userId'
FROM config_asset_revisions r
JOIN config_assets a ON a.id = r.asset_id AND a.kind = 'workflow'
JOIN audit_events e ON e.client_instance_id = r.client_instance_id
  AND e.type = 'config_asset.published' AND e.status = 'success'
  AND e.metadata->>'kind' = 'workflow' AND e.metadata->>'name' = a.name
  AND e.metadata->>'revision' = r.revision::text
WHERE e.actor->>'userId' IS NOT NULL
ORDER BY r.id, e.created_at DESC, e.id DESC
ON CONFLICT DO NOTHING;
