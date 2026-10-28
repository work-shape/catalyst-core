-- The Data Stores a person added to a conversation for reading (STORE-USE-1): a new, empty
-- table of ids and a time, never a row of a store. Its foreign keys lock conversations,
-- config_assets and product_users briefly; a busy table fails the migration instead of holding
-- up chats and sign-ins.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "conversation_data_stores" (
	"conversation_id" text NOT NULL,
	"store_asset_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"added_by_user_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_data_stores_pk" PRIMARY KEY("conversation_id","store_asset_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_data_stores" ADD CONSTRAINT "conversation_data_stores_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_data_stores" ADD CONSTRAINT "conversation_data_stores_store_asset_id_config_assets_id_fk" FOREIGN KEY ("store_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_data_stores" ADD CONSTRAINT "conversation_data_stores_added_by_fk" FOREIGN KEY ("client_instance_id","added_by_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_data_stores_store_idx" ON "conversation_data_stores" USING btree ("store_asset_id");--> statement-breakpoint
CREATE INDEX "conversation_data_stores_added_by_idx" ON "conversation_data_stores" USING btree ("client_instance_id","added_by_user_id");