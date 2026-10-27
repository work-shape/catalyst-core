-- What a preview last reported of itself (PREVIEW-STATUS-1): a new, empty table. Its foreign
-- keys lock conversations and file_sets briefly; a busy table fails the migration instead of
-- holding up every conversation write.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "preview_reports" (
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"file_set_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "preview_reports_pk" PRIMARY KEY("conversation_id","file_set_id")
);
--> statement-breakpoint
ALTER TABLE "preview_reports" ADD CONSTRAINT "preview_reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_reports" ADD CONSTRAINT "preview_reports_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_reports_file_set_idx" ON "preview_reports" USING btree ("file_set_id");--> statement-breakpoint
CREATE INDEX "preview_reports_reported_at_idx" ON "preview_reports" USING btree ("reported_at");