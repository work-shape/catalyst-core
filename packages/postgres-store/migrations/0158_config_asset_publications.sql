-- A busy config_assets fails the migration rather than holding every write of an asset.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "config_asset_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"revision" integer NOT NULL,
	"number" integer NOT NULL,
	"actor" jsonb,
	"published_at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "config_asset_publications_asset_number_idx" ON "config_asset_publications" USING btree ("asset_id","number");--> statement-breakpoint
-- Every asset published today gets its publication 1, of the revision its pointer names: at
-- the time and by whom its newest retained successful publish event of that revision says, as
-- the App's head read it so far, or else at the asset's last change and by nobody named. An
-- actor whose account is gone is not copied: its deletion emptied every copy but audit's.
INSERT INTO "config_asset_publications" ("id", "client_instance_id", "asset_id", "revision", "number", "actor", "published_at")
WITH "published" AS (
	SELECT a."id", a."client_instance_id", a."kind", a."name", a."created_at", a."updated_at", r."revision"
	FROM "config_assets" a
	JOIN "config_asset_revisions" r ON r."id" = a."published_revision_id"
), "retained" AS (
	SELECT DISTINCT ON (p."id") p."id", e."actor", e."created_at"
	FROM "audit_events" e
	JOIN "published" p
		ON e."client_instance_id" = p."client_instance_id"
		AND e."metadata"->>'kind' = p."kind"
		AND e."metadata"->>'name' = p."name"
		AND e."metadata"->>'revision' = p."revision"::text
	WHERE e."type" IN ('app.published', 'config_asset.published', 'guardrail.published')
		AND e."status" = 'success'
		AND e."created_at" >= p."created_at"
	ORDER BY p."id", e."created_at" DESC, e."id" DESC
)
SELECT 'publication_' || gen_random_uuid()::text, p."client_instance_id", p."id", p."revision", 1,
	CASE WHEN r."actor"->>'userId' IS NULL OR EXISTS (
		SELECT 1 FROM "product_users" u
		WHERE u."id" = r."actor"->>'userId' AND u."client_instance_id" = p."client_instance_id"
	) THEN r."actor" END,
	coalesce(r."created_at", p."updated_at")
FROM "published" p
LEFT JOIN "retained" r ON r."id" = p."id";--> statement-breakpoint
-- The key comes last: its lock on config_assets then waits only for the check of the rows above.
ALTER TABLE "config_asset_publications" ADD CONSTRAINT "config_asset_publications_asset_id_config_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;