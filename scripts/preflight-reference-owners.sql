-- Read-only REF-OWNER preflight. Run on one instance's platform database, never its store DBs:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/preflight-reference-owners.sql
-- Counts distinct source/target pairs across current draft and published revisions, not
-- repeated mentions. Deleted assets and historical revisions are excluded. No data changes.
BEGIN READ ONLY;
WITH RECURSIVE revisions AS (
  SELECT a.*, r.config, r.id AS revision_id
  FROM config_assets a
  JOIN config_asset_revisions r
    ON r.id = a.active_revision_id OR r.id = a.published_revision_id
  WHERE a.status = 'active'
  UNION ALL
  SELECT a.*, r.config, 'draft:' || p.id || ':' || p.revision::text AS revision_id
  FROM config_assets a
  JOIN agent_change_proposals p ON p.agent_id = a.id
  JOIN agent_change_proposal_revisions r ON r.proposal_id = p.id AND r.revision = p.revision
  WHERE a.status = 'active' AND a.kind = 'agent'
), steps AS (
  SELECT DISTINCT id, revision_id, step
  FROM revisions CROSS JOIN LATERAL
    jsonb_path_query(config, 'lax $.manifest.steps.** ? (@.type != null)') step
  WHERE kind = 'workflow'
), named AS (
  SELECT r.id, r.revision_id, f.kind, n.name
  FROM revisions r
  CROSS JOIN (VALUES ('skillNames', 'skill'), ('knowledgeBases', 'knowledge_base'),
    ('subagentNames', 'agent')) AS f(field, kind)
  CROSS JOIN LATERAL jsonb_array_elements_text(r.config -> f.field) n(name)
  WHERE r.kind = 'agent'
  UNION ALL
  SELECT id, revision_id, 'data_store', config #>> '{backend,dataStore}'
  FROM revisions WHERE kind = 'knowledge_base'
  UNION ALL
  SELECT id, revision_id, 'connection', s ->> 'connection'
  FROM revisions CROSS JOIN LATERAL jsonb_array_elements(config -> 'sources') s
  WHERE kind = 'knowledge_base'
  UNION ALL
  SELECT id, revision_id, 'connection', c
  FROM revisions CROSS JOIN LATERAL jsonb_array_elements_text(config #> '{manifest,connections}') c
  WHERE kind = 'app'
  UNION ALL
  SELECT id, revision_id, 'data_store', s ->> 'name'
  FROM revisions CROSS JOIN LATERAL jsonb_array_elements(config #> '{manifest,dataStores}') s
  WHERE kind = 'app'
  UNION ALL
  SELECT id, revision_id,
    CASE a ->> 'kind' WHEN 'sql' THEN 'data_store' ELSE a ->> 'kind' END,
    CASE a ->> 'kind' WHEN 'sql' THEN a ->> 'dataStore'
      WHEN 'connection' THEN a ->> 'connection' WHEN 'workflow' THEN a ->> 'workflow' END
  FROM revisions CROSS JOIN LATERAL jsonb_array_elements(config #> '{manifest,actions}') a
  WHERE kind = 'app'
  UNION ALL
  SELECT id, revision_id, 'workflow', step ->> 'workflow' FROM steps WHERE step ->> 'type' = 'workflow'
  UNION ALL
  SELECT id, revision_id, 'app', step #>> '{link,app}' FROM steps
    WHERE step ->> 'type' = 'notify' AND step #>> '{link,kind}' = 'app'
  UNION ALL
  SELECT id, revision_id, 'workflow', substr(config #>> '{manifest,onFailure}', 10)
  FROM revisions WHERE kind = 'workflow' AND config #>> '{manifest,onFailure}' LIKE 'workflow.%'

), operations AS (
  SELECT id, revision_id, step ->> 'operation' AS operation FROM steps WHERE step ->> 'type' = 'operation'
  UNION ALL
  SELECT id, revision_id, t FROM revisions CROSS JOIN LATERAL jsonb_array_elements_text(config #> '{manifest,tools}') t WHERE kind = 'workflow'
  UNION ALL
  SELECT id, revision_id, t FROM revisions CROSS JOIN LATERAL jsonb_array_elements_text(config -> 'toolNames') t WHERE kind = 'agent'

), refs AS (
  SELECT id, revision_id, kind, name FROM named WHERE name IS NOT NULL
  UNION
  SELECT id, revision_id,
    CASE split_part(operation, '.', 1) WHEN 'knowledge' THEN 'knowledge_base' ELSE split_part(operation, '.', 1) END,
    split_part(operation, '.', 2)
  FROM operations
  WHERE operation ~ '^(connection|data_store|knowledge|workflow|app)\.[^.]+\.'
    AND split_part(operation, '.', 2) <> '*'
), refused AS (
  SELECT DISTINCT s.client_instance_id, s.kind AS source_kind, s.name AS source_name,
    s.scope_kind AS source_owner_kind, s.scope_id AS source_workspace,
    t.kind AS target_kind, t.name AS target_name, t.scope_id AS target_workspace
  FROM refs r JOIN config_assets s ON s.id = r.id
  JOIN config_assets t ON t.client_instance_id = s.client_instance_id
    AND t.kind = r.kind AND t.name = r.name AND t.status = 'active'
  WHERE t.scope_kind = 'workspace'
    AND NOT (s.kind = 'workflow' AND t.kind IN ('app', 'data_store', 'knowledge_base'))
    AND (s.scope_kind <> 'workspace' OR s.scope_id IS DISTINCT FROM t.scope_id)
)
SELECT instances.client_instance_id, count(refused.source_name) AS refused_references,
  count(DISTINCT (source_kind, source_name)) FILTER (WHERE refused.source_name IS NOT NULL) AS affected_assets,
  coalesce(jsonb_agg(to_jsonb(refused) - 'client_instance_id'
    ORDER BY source_kind, source_name, target_kind, target_name)
    FILTER (WHERE refused.source_name IS NOT NULL), '[]'::jsonb) AS references
FROM config_asset_state instances LEFT JOIN refused USING (client_instance_id)
GROUP BY instances.client_instance_id;
COMMIT;
