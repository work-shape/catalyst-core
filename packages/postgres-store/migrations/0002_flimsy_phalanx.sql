ALTER TABLE "conversation_attachments" ADD COLUMN "processing_owner_id" text;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "processing_lease_token" text;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_attachments_processing_idx" ON "conversation_attachments" USING btree ("client_instance_id","status","processing_lease_expires_at","created_at");