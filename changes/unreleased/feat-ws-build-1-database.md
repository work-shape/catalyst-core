---
section: Database
---

- Migration `0124_workspace_build_limits` adds two nullable `jsonb` columns, `allowed_tool_names` and `allowed_model_binding_ids`, to `collaboration_workspaces`. Run migrations before app and worker startup. Null adds no limit, so existing workspaces are unchanged. The previous release ignores the columns; rolling back leaves them in place and drops the limits' effect, and `builder` and `publisher` rows then grant nothing.
