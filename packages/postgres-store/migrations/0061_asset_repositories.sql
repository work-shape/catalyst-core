-- The two columns on "config_asset_revisions" and the key of "asset_checkouts" to "conversations"
-- and "config_assets" each need a lock that every reader of those tables waits behind. The
-- migration gives up after five seconds and is run again, and holds up nobody for longer.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "asset_checkouts" (
	"conversation_id" text NOT NULL,
	"folder" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"base_commit" text NOT NULL,
	"base_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_checkouts_pk" PRIMARY KEY("conversation_id","folder")
);
--> statement-breakpoint
CREATE TABLE "asset_repo_bundles" (
	"asset_id" text NOT NULL,
	"operation_run_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"state" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"sequence" integer,
	"object_key" text,
	"kind" text,
	"tip_commit" text,
	"prerequisite_commit" text,
	"bytes" bigint,
	"sha256" text,
	"superseded_at" timestamp with time zone,
	"swept_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_repo_bundles_pk" PRIMARY KEY("asset_id","operation_run_id"),
	CONSTRAINT "asset_repo_bundles_state_check" CHECK ("asset_repo_bundles"."state" in ('pending', 'live', 'swept')),
	CONSTRAINT "asset_repo_bundles_live_check" CHECK (("asset_repo_bundles"."state" = 'live') = ("asset_repo_bundles"."sequence" is not null) and ("asset_repo_bundles"."state" <> 'live' or "asset_repo_bundles"."object_key" is not null)),
	CONSTRAINT "asset_repo_bundles_swept_check" CHECK (("asset_repo_bundles"."state" = 'swept') = ("asset_repo_bundles"."swept_at" is not null)),
	CONSTRAINT "asset_repo_bundles_named_check" CHECK (num_nonnulls("asset_repo_bundles"."object_key", "asset_repo_bundles"."kind", "asset_repo_bundles"."tip_commit", "asset_repo_bundles"."bytes", "asset_repo_bundles"."sha256") in (0, 5)),
	CONSTRAINT "asset_repo_bundles_kind_check" CHECK ("asset_repo_bundles"."kind" in ('full', 'incremental')),
	CONSTRAINT "asset_repo_bundles_format_check" CHECK ("asset_repo_bundles"."tip_commit" ~ '^[0-9a-f]{40}$' and "asset_repo_bundles"."prerequisite_commit" ~ '^[0-9a-f]{40}$' and "asset_repo_bundles"."sha256" ~ '^[0-9a-f]{64}$' and "asset_repo_bundles"."bytes" > 0),
	CONSTRAINT "asset_repo_bundles_prerequisite_check" CHECK ("asset_repo_bundles"."kind" is null or ("asset_repo_bundles"."kind" = 'full') = ("asset_repo_bundles"."prerequisite_commit" is null))
);
--> statement-breakpoint
ALTER TABLE "config_asset_revisions" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "config_asset_revisions" ADD COLUMN "tree" text;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_checkouts_asset_idx" ON "asset_checkouts" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_repo_bundles_sequence_idx" ON "asset_repo_bundles" USING btree ("asset_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_repo_bundles_object_key_idx" ON "asset_repo_bundles" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "asset_repo_bundles_unfinished_idx" ON "asset_repo_bundles" USING btree ("state","saved_at") WHERE "asset_repo_bundles"."state" <> 'live';