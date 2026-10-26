CREATE TABLE "model_provider_turn_continuations" (
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"state" jsonb NOT NULL,
	"source_message_id" text NOT NULL,
	"source_storage_ordinal" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_provider_turn_continuations_pk" PRIMARY KEY("client_instance_id","conversation_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "model_provider_turn_continuations" ADD CONSTRAINT "model_provider_turn_continuations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_turn_continuations" ADD CONSTRAINT "model_provider_turn_continuations_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;