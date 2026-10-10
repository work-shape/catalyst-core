CREATE TABLE "file_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"number" integer NOT NULL,
	"kit_version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"source_files" jsonb NOT NULL,
	"built_files" jsonb NOT NULL,
	"source_file_count" integer NOT NULL,
	"built_file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_sets_owner_number_idx" ON "file_sets" USING btree ("owner_kind","owner_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_conversation_name_idx" ON "pages" USING btree ("client_instance_id","conversation_id","name");