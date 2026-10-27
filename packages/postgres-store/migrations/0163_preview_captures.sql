-- The pictures of a preview a run asked for (PREVIEW-SEE-1): a new, empty table of requests,
-- never the pictures. Its foreign keys lock conversations, product_users and file_sets briefly;
-- a busy table fails the migration instead of holding up their writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "preview_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"file_set_id" text NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"artifact_id" text,
	"width" integer,
	"height" integer,
	"requested_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "preview_captures_status_check" CHECK ("preview_captures"."status" in ('pending', 'answering', 'captured', 'refused'))
);
--> statement-breakpoint
ALTER TABLE "preview_captures" ADD CONSTRAINT "preview_captures_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_captures" ADD CONSTRAINT "preview_captures_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_captures" ADD CONSTRAINT "preview_captures_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preview_captures_tool_call_idx" ON "preview_captures" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "preview_captures_user_idx" ON "preview_captures" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "preview_captures_conversation_idx" ON "preview_captures" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "preview_captures_file_set_idx" ON "preview_captures" USING btree ("file_set_id");--> statement-breakpoint
CREATE INDEX "preview_captures_requested_at_idx" ON "preview_captures" USING btree ("requested_at");