---
section: Changed
---

- **Workspace tools:** Removed `workspace.apply_patch` and its unified diff implementation. Use `workspace.edit_file` with exact text edits instead. There is no alias and patch inputs are unsupported. Existing release configs and stored agents that still name the retired tool start with a warning naming `workspace.edit_file`; the retired tool is never offered or executed.
