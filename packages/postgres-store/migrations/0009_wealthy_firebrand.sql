CREATE TABLE "artifact_preview_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"source_artifact_id" text NOT NULL,
	"source_checksum" text NOT NULL,
	"source_mime_type" text NOT NULL,
	"renderer" text NOT NULL,
	"renderer_version" text NOT NULL,
	"settings_hash" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner_id" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_preview_manifests" (
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"source_artifact_id" text NOT NULL,
	"status" text NOT NULL,
	"type" text,
	"format" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artifact_preview_manifests_pk" PRIMARY KEY("client_instance_id","source_artifact_id")
);
--> statement-breakpoint
ALTER TABLE "artifact_preview_jobs" ADD CONSTRAINT "artifact_preview_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_preview_jobs" ADD CONSTRAINT "artifact_preview_jobs_source_artifact_id_managed_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."managed_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_preview_manifests" ADD CONSTRAINT "artifact_preview_manifests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_preview_manifests" ADD CONSTRAINT "artifact_preview_manifests_source_artifact_id_managed_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."managed_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_preview_jobs_source_settings_idx" ON "artifact_preview_jobs" USING btree ("client_instance_id","source_artifact_id","renderer","renderer_version","settings_hash");--> statement-breakpoint
CREATE INDEX "artifact_preview_jobs_queue_idx" ON "artifact_preview_jobs" USING btree ("client_instance_id","status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "artifact_preview_jobs_conversation_idx" ON "artifact_preview_jobs" USING btree ("client_instance_id","conversation_id");--> statement-breakpoint
CREATE INDEX "artifact_preview_manifests_conversation_idx" ON "artifact_preview_manifests" USING btree ("client_instance_id","conversation_id");