CREATE TABLE "conversation_created_assets" (
	"conversation_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_created_assets_pk" PRIMARY KEY("conversation_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_created_assets" ADD CONSTRAINT "conversation_created_assets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_created_assets" ADD CONSTRAINT "conversation_created_assets_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_created_assets_asset_idx" ON "conversation_created_assets" USING btree ("asset_id");