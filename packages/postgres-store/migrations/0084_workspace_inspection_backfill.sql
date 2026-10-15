-- Path previews originally used execution_workspace_preview (a5e10f389). 5a1b3e5dd
-- changed that to execution_workspace without recording a purpose. Until 81540aacf
-- they received the same random art_* ids as promoted files, so names, paths,
-- image types and missing promotion metadata cannot distinguish those rows.
-- A retained path-preview result proves which exact row the tool created. Never
-- infer inspection from artifactId-mode calls: they can inspect a user's final file.
-- Rows without this evidence remain unchanged. Preserve every other metadata key.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
UPDATE managed_artifacts AS m
SET metadata = jsonb_set(m.metadata, '{purpose}', '"inspection"'::jsonb)
WHERE m.source_file_id IS NULL
  AND NOT (m.metadata ? 'purpose')
  AND jsonb_typeof(m.metadata->'workspaceId') = 'string'
  AND jsonb_typeof(m.metadata->'workspacePath') = 'string'
  AND m.filename = regexp_replace(m.metadata->>'workspacePath', '^.*/', '')
  AND (m.kind, m.mime_type) IN (
    ('image.png', 'image/png'), ('image.jpeg', 'image/jpeg'),
    ('image.webp', 'image/webp'), ('image.gif', 'image/gif')
  )
  AND (
    m.metadata->>'source' = 'execution_workspace_preview'
    OR (
      m.metadata->>'source' = 'execution_workspace'
      AND EXISTS (
        SELECT 1
        FROM messages AS t
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.metadata #> '{agentRuntime,result,artifacts}') = 'array'
            THEN t.metadata #> '{agentRuntime,result,artifacts}' ELSE '[]'::jsonb END
        ) AS ref(value)
        WHERE t.client_instance_id = m.client_instance_id
          AND t.conversation_id = m.conversation_id
          AND t.role = 'tool'
          AND t.metadata #> '{agentRuntime,version}' = '1'::jsonb
          AND t.metadata #>> '{agentRuntime,kind}' = 'tool_result'
          AND t.metadata #>> '{agentRuntime,toolName}' = 'workspace.preview_images'
          AND t.metadata #>> '{agentRuntime,result,status}' = 'success'
          AND (
            jsonb_typeof(t.metadata #> '{agentRuntime,input,path}') = 'string'
            OR jsonb_typeof(t.metadata #> '{agentRuntime,input,paths}') = 'array'
          )
          AND ref.value->>'artifactId' = m.id
          AND ref.value->>'kind' = m.kind
          AND ref.value->>'mimeType' = m.mime_type
          AND ref.value #>> '{modelVisibility,type}' = 'image'
          AND ref.value #>> '{metadata,sourceArtifactId}' = m.id
          AND ref.value #>> '{metadata,status}' = 'ready'
          AND ref.value #>> '{metadata,workspacePath}' = m.metadata->>'workspacePath'
      )
    )
  );
