CREATE TABLE "structured_data_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"resource_key" text NOT NULL,
	"title" text NOT NULL,
	"state" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "structured_data_resources" ADD CONSTRAINT "structured_data_resources_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "structured_data_resources_conversation_key_idx" ON "structured_data_resources" USING btree ("client_instance_id","conversation_id","resource_key");