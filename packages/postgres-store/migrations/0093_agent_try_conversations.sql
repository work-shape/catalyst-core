CREATE TABLE "agent_try_conversations" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"build_conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_try_conversations" ADD CONSTRAINT "agent_try_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_try_conversations" ADD CONSTRAINT "agent_try_conversations_build_conversation_id_conversations_id_fk" FOREIGN KEY ("build_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_try_conversations_current_idx" ON "agent_try_conversations" USING btree ("build_conversation_id","agent_id") WHERE "agent_try_conversations"."replaced_at" is null;--> statement-breakpoint
CREATE INDEX "agent_try_conversations_build_idx" ON "agent_try_conversations" USING btree ("build_conversation_id","agent_id");