-- Expand: an asset a workspace owns names a workspace that exists. Added without a scan of
-- the table; the next migration validates it. Nothing cascades: the workspace delete removes
-- its assets itself, and this key refuses one that does not.
ALTER TABLE "config_assets" ADD CONSTRAINT "config_assets_scope_workspace_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE no action ON UPDATE no action NOT VALID;
