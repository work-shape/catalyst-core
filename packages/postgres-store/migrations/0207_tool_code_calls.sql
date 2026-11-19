CREATE TABLE "tool_code_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"tool" text NOT NULL,
	"revision_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_code_calls" ADD CONSTRAINT "tool_code_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_code_calls_conversation_idx" ON "tool_code_calls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "tool_code_calls_created_idx" ON "tool_code_calls" USING btree ("client_instance_id","created_at");