CREATE TABLE "conversation_follow_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"text" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"position" integer NOT NULL,
	"agent_name" text NOT NULL,
	"model_binding_id" text,
	"reasoning_effort" text,
	"idempotency_key" text,
	"authorization_context" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"dispatched_run_id" text
);
--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "follow_up_id" text;--> statement-breakpoint
ALTER TABLE "conversation_follow_ups" ADD CONSTRAINT "conversation_follow_ups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_follow_ups_position_idx" ON "conversation_follow_ups" USING btree ("client_instance_id","conversation_id","position");--> statement-breakpoint
CREATE INDEX "conversation_follow_ups_pending_idx" ON "conversation_follow_ups" USING btree ("client_instance_id","conversation_id","position") WHERE "conversation_follow_ups"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_follow_ups_idempotency_idx" ON "conversation_follow_ups" USING btree ("client_instance_id","author_user_id","idempotency_key") WHERE "conversation_follow_ups"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_follow_up_id_conversation_follow_ups_id_fk" FOREIGN KEY ("follow_up_id") REFERENCES "public"."conversation_follow_ups"("id") ON DELETE set null ON UPDATE no action NOT VALID;