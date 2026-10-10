-- Expand: who owns an asset. Every existing row is owned by the instance through the default,
-- and a release that does not write the columns keeps writing instance assets. The checks are
-- added without a scan of the table; the next migration validates them.
ALTER TABLE "config_assets" ADD COLUMN "scope_kind" text DEFAULT 'instance' NOT NULL;--> statement-breakpoint
ALTER TABLE "config_assets" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "config_assets" ADD CONSTRAINT "config_assets_scope_kind_check" CHECK ("config_assets"."scope_kind" in ('instance', 'workspace')) NOT VALID;--> statement-breakpoint
ALTER TABLE "config_assets" ADD CONSTRAINT "config_assets_scope_id_check" CHECK (("config_assets"."scope_kind" = 'instance') = ("config_assets"."scope_id" is null)) NOT VALID;
