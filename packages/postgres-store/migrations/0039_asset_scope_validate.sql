-- In a transaction of its own: the scan holds only a lock that reads and writes pass.
ALTER TABLE "config_assets" VALIDATE CONSTRAINT "config_assets_scope_kind_check";--> statement-breakpoint
ALTER TABLE "config_assets" VALIDATE CONSTRAINT "config_assets_scope_id_check";
