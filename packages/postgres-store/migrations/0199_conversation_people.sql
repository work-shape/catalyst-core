-- The people the creator of a private chat named (CHAT-SHARE-1): a new, empty table of ids and a
-- time. Its foreign keys lock conversations and product_users briefly; a busy table fails the
-- migration instead of holding up chats and sign-ins.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "conversation_people" (
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by_user_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_people_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_people" ADD CONSTRAINT "conversation_people_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_people" ADD CONSTRAINT "conversation_people_user_fk" FOREIGN KEY ("client_instance_id","user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_people_user_idx" ON "conversation_people" USING btree ("client_instance_id","user_id");