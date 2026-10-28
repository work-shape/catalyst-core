-- Read-only OWNER-REACH preflight. Run on one instance's platform database, never its store DBs:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/preflight-owner-reach.sql
-- Counts what a Personal Workspace owns that is shared today, which `assertOwnerReach` refuses
-- from now on and leaves running until its next change:
--   offers:     an agent, Knowledge Base or Connection of a Personal Workspace offered in a Shared
--               Workspace, in every Personal Workspace or everywhere; an App of one live for
--               the whole instance.
--   references: an instance Workflow's current draft or published revision naming a Personal
--               Workspace's Data Store, Knowledge Base or App (its operations, tools and links).
-- Each source/target pair is counted once. Deleted assets and older revisions are left out.
-- No data changes.
BEGIN READ ONLY;
WITH personal AS (
  SELECT a.client_instance_id, a.id, a.kind, a.name, a.scope_id AS workspace_id
  FROM config_assets a
  JOIN collaboration_workspaces w ON w.id = a.scope_id AND w.kind = 'personal'
  WHERE a.status = 'active' AND a.scope_kind = 'workspace'
), offered AS (
  SELECT p.client_instance_id, 'offer' AS violation, p.kind AS source_kind, p.name AS source_name,
    NULL::text AS target_kind, NULL::text AS target_name,
    CASE WHEN v.mode = 'all' THEN 'all'
      WHEN v.personal_workspaces THEN 'personal_workspaces'
      ELSE 'shared_workspaces' END AS offered_in
  FROM personal p
  JOIN config_asset_availability v ON v.asset_id = p.id
  WHERE (p.kind = 'app' AND v.mode = 'all')
    OR (p.kind <> 'app' AND (v.mode = 'all' OR v.personal_workspaces OR EXISTS (
      SELECT 1 FROM config_asset_workspace_availability s WHERE s.asset_id = p.id)))
), revisions AS (
  SELECT a.id, r.config
  FROM config_assets a
  JOIN config_asset_revisions r
    ON r.id = a.active_revision_id OR r.id = a.published_revision_id
  WHERE a.status = 'active' AND a.kind = 'workflow' AND a.scope_kind = 'instance'
), steps AS (
  SELECT id, step
  FROM revisions CROSS JOIN LATERAL
    jsonb_path_query(config, 'lax $.manifest.steps.** ? (@.type != null)') step
), operations AS (
  SELECT id, step ->> 'operation' AS operation FROM steps WHERE step ->> 'type' = 'operation'
  UNION ALL
  SELECT id, t FROM revisions CROSS JOIN LATERAL jsonb_array_elements_text(config #> '{manifest,tools}') t
), refs AS (
  SELECT id,
    CASE split_part(operation, '.', 1) WHEN 'knowledge' THEN 'knowledge_base'
      ELSE split_part(operation, '.', 1) END AS kind,
    split_part(operation, '.', 2) AS name
  FROM operations
  WHERE operation ~ '^(data_store|knowledge|app)\.[^.]+\.'
  UNION
  SELECT id, 'app', step #>> '{link,app}' FROM steps
  WHERE step ->> 'type' = 'notify' AND step #>> '{link,kind}' = 'app'
), referenced AS (
  SELECT DISTINCT s.client_instance_id, 'reference' AS violation, s.kind AS source_kind,
    s.name AS source_name, p.kind AS target_kind, p.name AS target_name, NULL::text AS offered_in
  FROM refs r
  JOIN config_assets s ON s.id = r.id
  JOIN personal p ON p.client_instance_id = s.client_instance_id
    AND p.kind = r.kind AND p.name = r.name
), violations AS (
  SELECT * FROM offered UNION ALL SELECT * FROM referenced
)
SELECT instances.client_instance_id,
  count(*) FILTER (WHERE violation = 'offer') AS offers,
  count(*) FILTER (WHERE violation = 'reference') AS "references",
  coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(violations) - 'client_instance_id')
    ORDER BY violation, source_kind, source_name, target_kind, target_name)
    FILTER (WHERE violation IS NOT NULL), '[]'::jsonb) AS violations
FROM config_asset_state instances LEFT JOIN violations USING (client_instance_id)
GROUP BY instances.client_instance_id;
COMMIT;
