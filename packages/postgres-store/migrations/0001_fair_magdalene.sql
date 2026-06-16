CREATE TABLE "managed_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"source_file_id" text,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"filename" text,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "prepared_text_artifact_id" text;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "prepared_pages_artifact_id" text;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "preprocessing_engine" text;--> statement-breakpoint
ALTER TABLE "managed_artifacts" ADD CONSTRAINT "managed_artifacts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_artifacts" ADD CONSTRAINT "managed_artifacts_source_file_id_managed_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."managed_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_artifacts_conversation_idx" ON "managed_artifacts" USING btree ("client_instance_id","conversation_id");--> statement-breakpoint
CREATE INDEX "managed_artifacts_file_kind_idx" ON "managed_artifacts" USING btree ("client_instance_id","conversation_id","source_file_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "managed_artifacts_object_key_idx" ON "managed_artifacts" USING btree ("client_instance_id","object_key");--> statement-breakpoint
ALTER TABLE "conversation_attachments" DROP COLUMN "prepared_document_id";--> statement-breakpoint
ALTER TABLE "conversation_attachments" DROP COLUMN "prepared_object_key";