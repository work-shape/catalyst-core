CREATE TABLE "collaboration_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text NOT NULL,
	"emoji" text,
	"accent_color" text,
	"personal_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "collaboration_workspaces_personal_kind_check" CHECK (("collaboration_workspaces"."kind" = 'personal') = ("collaboration_workspaces"."personal_user_id" is not null)),
	CONSTRAINT "collaboration_workspaces_personal_visibility_check" CHECK ("collaboration_workspaces"."kind" <> 'personal' or "collaboration_workspaces"."visibility" = 'private')
);
--> statement-breakpoint
CREATE TABLE "collaboration_workspace_memberships" (
	"collaboration_workspace_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "collaboration_workspace_memberships_pk" PRIMARY KEY("collaboration_workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "collaboration_workspace_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"collaboration_workspace_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_workspaces_client_id_idx" ON "collaboration_workspaces" USING btree ("client_instance_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_workspaces_personal_user_idx" ON "collaboration_workspaces" USING btree ("client_instance_id","personal_user_id") WHERE "collaboration_workspaces"."kind" = 'personal';
--> statement-breakpoint
CREATE INDEX "collaboration_workspace_memberships_user_idx" ON "collaboration_workspace_memberships" USING btree ("client_instance_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_workspace_access_requests_workspace_user_idx" ON "collaboration_workspace_access_requests" USING btree ("collaboration_workspace_id","user_id");
--> statement-breakpoint
CREATE INDEX "collaboration_workspace_access_requests_workspace_idx" ON "collaboration_workspace_access_requests" USING btree ("client_instance_id","collaboration_workspace_id");
--> statement-breakpoint
ALTER TABLE "collaboration_workspaces" ADD CONSTRAINT "collaboration_workspaces_personal_user_fk" FOREIGN KEY ("client_instance_id","personal_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_workspace_memberships" ADD CONSTRAINT "collaboration_workspace_memberships_workspace_fk" FOREIGN KEY ("client_instance_id","collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_workspace_memberships" ADD CONSTRAINT "collaboration_workspace_memberships_user_fk" FOREIGN KEY ("client_instance_id","user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_workspace_access_requests" ADD CONSTRAINT "collaboration_workspace_access_requests_workspace_fk" FOREIGN KEY ("client_instance_id","collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_workspace_access_requests" ADD CONSTRAINT "collaboration_workspace_access_requests_user_fk" FOREIGN KEY ("client_instance_id","user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "collaboration_workspace_id" text;
--> statement-breakpoint
INSERT INTO "collaboration_workspaces" (
	"id",
	"client_instance_id",
	"kind",
	"name",
	"description",
	"visibility",
	"emoji",
	"accent_color",
	"personal_user_id",
	"created_at",
	"updated_at"
)
SELECT
	'cws_' || gen_random_uuid()::text,
	"product_users"."client_instance_id",
	'personal',
	'Personal workspace',
	NULL,
	'private',
	NULL,
	NULL,
	"product_users"."id",
	"product_users"."created_at",
	"product_users"."updated_at"
FROM "product_users"
WHERE NOT EXISTS (
	SELECT 1
	FROM "collaboration_workspaces"
	WHERE "collaboration_workspaces"."client_instance_id" = "product_users"."client_instance_id"
		AND "collaboration_workspaces"."kind" = 'personal'
		AND "collaboration_workspaces"."personal_user_id" = "product_users"."id"
);
--> statement-breakpoint
INSERT INTO "collaboration_workspace_memberships" (
	"collaboration_workspace_id",
	"client_instance_id",
	"user_id",
	"role",
	"created_at",
	"updated_at"
)
SELECT
	"collaboration_workspaces"."id",
	"collaboration_workspaces"."client_instance_id",
	"collaboration_workspaces"."personal_user_id",
	'owner',
	"collaboration_workspaces"."created_at",
	"collaboration_workspaces"."updated_at"
FROM "collaboration_workspaces"
WHERE "collaboration_workspaces"."kind" = 'personal'
ON CONFLICT ("collaboration_workspace_id", "user_id") DO NOTHING;
--> statement-breakpoint
UPDATE "conversations"
SET "collaboration_workspace_id" = "collaboration_workspaces"."id"
FROM "collaboration_workspaces"
WHERE "conversations"."client_instance_id" = "collaboration_workspaces"."client_instance_id"
	AND "conversations"."owner_user_id" = "collaboration_workspaces"."personal_user_id"
	AND "collaboration_workspaces"."kind" = 'personal'
	AND "conversations"."collaboration_workspace_id" IS NULL;
--> statement-breakpoint
DO $$
DECLARE
	unmapped_count bigint;
BEGIN
	SELECT count(*) INTO unmapped_count
	FROM "conversations"
	WHERE "collaboration_workspace_id" IS NULL;

	IF unmapped_count > 0 THEN
		RAISE EXCEPTION 'Collaboration Workspace backfill left % conversation(s) unmapped', unmapped_count;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "collaboration_workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_collaboration_workspace_fk" FOREIGN KEY ("client_instance_id","collaboration_workspace_id") REFERENCES "public"."collaboration_workspaces"("client_instance_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversations_collaboration_workspace_idx" ON "conversations" USING btree ("client_instance_id","collaboration_workspace_id");
