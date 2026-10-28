-- Project files (PRJ-2): each project file as it is now, and its kept versions. Both tables are
-- new and empty, so their keys validate no row; the key to config_assets takes its lock briefly.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "project_file_versions" (
	"project_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"path" text NOT NULL,
	"version" integer NOT NULL,
	"object_key" text,
	"byte_size" bigint NOT NULL,
	"checksum" text,
	"mime_type" text,
	"origin" text NOT NULL,
	"by_user_id" text,
	"conversation_id" text,
	"run_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_file_versions_pk" PRIMARY KEY("project_id","path","version"),
	CONSTRAINT "project_file_versions_origin_check" CHECK ("project_file_versions"."origin" in ('person', 'agent', 'upload'))
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"project_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"path" text NOT NULL,
	"current_version" integer NOT NULL,
	"object_key" text,
	"byte_size" bigint NOT NULL,
	"checksum" text,
	"mime_type" text,
	"origin" text NOT NULL,
	"updated_by_user_id" text,
	"conversation_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_files_pk" PRIMARY KEY("project_id","path"),
	CONSTRAINT "project_files_origin_check" CHECK ("project_files"."origin" in ('person', 'agent', 'upload')),
	CONSTRAINT "project_files_version_check" CHECK ("project_files"."current_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_file_fk" FOREIGN KEY ("project_id","path") REFERENCES "public"."project_files"("project_id","path") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_config_assets_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;