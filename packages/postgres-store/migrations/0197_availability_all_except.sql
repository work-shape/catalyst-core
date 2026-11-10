-- An asset may be offered in every workspace except the Shared Workspaces its availability
-- names (`all_except`), those made later included; the names stay in
-- `config_asset_workspace_availability`. The mode constraint is widened: every existing row
-- and every write of an older release still fits it. It is added NOT VALID and validated in
-- 0198, so the table is not scanned under the lock. An older release reads an `all_except` row
-- as `selected`: set such assets to another mode before running one.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "config_asset_availability" DROP CONSTRAINT "config_asset_availability_mode_check";--> statement-breakpoint
ALTER TABLE "config_asset_availability" ADD CONSTRAINT "config_asset_availability_mode_check" CHECK ("config_asset_availability"."mode" in ('all', 'selected', 'all_except')) NOT VALID;