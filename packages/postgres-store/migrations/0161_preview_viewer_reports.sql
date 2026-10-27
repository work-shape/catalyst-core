-- What a preview last reported of itself, kept per person whose browser showed it
-- (PREVIEW-STATUS-1b): a new, empty table. preview_reports is no longer written; a later
-- migration drops it. Its foreign keys lock conversations, product_users and file_sets briefly;
-- a busy table fails the migration instead of holding up their writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "preview_viewer_reports" (
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"file_set_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"noted_digest" text,
	CONSTRAINT "preview_viewer_reports_pk" PRIMARY KEY("conversation_id","user_id","file_set_id")
);
--> statement-breakpoint
ALTER TABLE "preview_viewer_reports" ADD CONSTRAINT "preview_viewer_reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_viewer_reports" ADD CONSTRAINT "preview_viewer_reports_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_viewer_reports" ADD CONSTRAINT "preview_viewer_reports_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_viewer_reports_file_set_idx" ON "preview_viewer_reports" USING btree ("file_set_id");--> statement-breakpoint
CREATE INDEX "preview_viewer_reports_user_idx" ON "preview_viewer_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "preview_viewer_reports_reported_at_idx" ON "preview_viewer_reports" USING btree ("reported_at");