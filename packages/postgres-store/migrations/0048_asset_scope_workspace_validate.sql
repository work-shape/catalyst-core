-- In a transaction of its own: the scan holds only a lock that reads and writes pass. No
-- release wrote an asset with a workspace as its owner, so every row passes.
ALTER TABLE "config_assets" VALIDATE CONSTRAINT "config_assets_scope_workspace_fk";
