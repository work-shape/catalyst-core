CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"actor" jsonb,
	"subject" text,
	"reason" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"file_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"byte_size" integer NOT NULL,
	"checksum" text NOT NULL,
	"status" text NOT NULL,
	"format" text,
	"prepared_document_id" text,
	"prepared_object_key" text,
	"character_count" integer,
	"word_count" integer,
	"page_count" integer,
	"warnings" jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"preprocessing_started_at" timestamp with time zone,
	"preprocessing_completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_external_user_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retained_until" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "managed_files" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"byte_size" integer NOT NULL,
	"checksum" text NOT NULL,
	"object_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"source" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_users" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"display_label" text NOT NULL,
	"email" text,
	"roles" jsonb NOT NULL,
	"permission_refs" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_authenticated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_identities" (
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"auth_source" text NOT NULL,
	"external_user_id" text NOT NULL,
	"display_label" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	CONSTRAINT "user_identities_pk" PRIMARY KEY("client_instance_id","auth_source","external_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "standalone_auth_profiles" (
	"client_instance_id" text NOT NULL,
	"auth_user_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"display_label" text NOT NULL,
	"roles" jsonb NOT NULL,
	"permission_refs" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "standalone_auth_profiles_pk" PRIMARY KEY("client_instance_id","auth_user_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_file_id_managed_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."managed_files"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_product_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."product_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "standalone_auth_profiles" ADD CONSTRAINT "standalone_auth_profiles_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_client_created_idx" ON "audit_events" USING btree ("client_instance_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_attachments_draft_idx" ON "conversation_attachments" USING btree ("client_instance_id","conversation_id","message_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_attachments_file_idx" ON "conversation_attachments" USING btree ("client_instance_id","conversation_id","file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_owner_idx" ON "conversations" USING btree ("client_instance_id","owner_external_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_owner_user_idx" ON "conversations" USING btree ("client_instance_id","owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "managed_files_client_owner_idx" ON "managed_files" USING btree ("client_instance_id","owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "managed_files_checksum_idx" ON "managed_files" USING btree ("client_instance_id","checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_idx" ON "messages" USING btree ("client_instance_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_usage_events_client_created_idx" ON "model_usage_events" USING btree ("client_instance_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_users_client_idx" ON "product_users" USING btree ("client_instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_user_idx" ON "user_identities" USING btree ("client_instance_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_account_provider_idx" ON "account" USING btree ("accountId","providerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standalone_auth_profiles_external_user_idx" ON "standalone_auth_profiles" USING btree ("client_instance_id","external_user_id");
