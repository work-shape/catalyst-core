# Historical workspace inspection images

Evidence comes only from platform Git history; no operated database was accessed.

- `a5e10f389` introduced path/paths previews. `previewWorkspaceImagePaths` in
  `packages/tool-execution/src/workspace-tools.ts` created a `managed_artifacts`
  row per image per call, with `metadata.source = execution_workspace_preview`.
- `5a1b3e5dd` changed that source to `execution_workspace`. It retained only
  `workspaceId` and `workspacePath`; no purpose or inspection flag was recorded.
- Immediately before `81540aacf`, the extracted writer was in
  `packages/tool-execution/src/workspace-tools/preview-images.ts`. It called
  `createManagedArtifact`; the Postgres file store supplied `art_<randomUUID>`
  (the shared ID helper also has a time/random fallback), `status = available`,
  `created_at = now()` and `source_file_id = null`. The image row copied the
  workspace file's `object_key`, `byte_size`, and `checksum`; its `filename` was
  the basename of `metadata.workspacePath`. MIME/kind pairs were `image/png` /
  `image.png`, `image/jpeg` / `image.jpeg`, `image/webp` / `image.webp`, and
  `image/gif` / `image.gif`. Paths were normalized workspace-relative paths,
  **not restricted to previews/**. MIME could be inferred from the extension.
- The workspace bytes and source file metadata were already stored separately
  (`execution_workspace_files`, with workspace/command records). The default
  object key was `execution-workspaces/<instance>/<conversation>/<workspace>/`
  `<command>/<checksum>/<path>` with encoded segments. Previewing reused it;
  it did not upload new bytes or create a `managed_files` upload row.
- `81540aacf` replaced random IDs with `art_workspace_preview_<sha256>`.
  `1dc0b52ca` later added `metadata.purpose = inspection` and the resource/search
  filters. Those changes did not mark the earlier random-ID rows.

## Identifying rule used by 0084

Require a workspace image with no source-file link or existing purpose, string
workspace ID/path, basename filename and one of the four exact MIME/kind pairs.
Then require either the historical preview-only source, or source
`execution_workspace` plus a retained **tool-role** message in the **same instance
and conversation** whose `metadata.agentRuntime` is version 1, kind `tool_result`,
tool `workspace.preview_images`, successful, with `input.path` or `input.paths`.
Its `result.artifacts` must name this exact artifact ID, kind and MIME, carry image
model visibility, and have `metadata.sourceArtifactId` equal to that same ID,
status `ready`, and the same workspace path.

The persisted envelope is produced by `createToolResultMetadata` in
`packages/core/src/message-metadata.ts` and stored in `messages.metadata` by the
agent runtime. The pre-81540aacf path-preview branch **always creates a new row**
and returns exactly those references. Promotion creates a separate row even for
the same path, bytes, name and type. An artifactId-mode call can inspect a final
user image, so that input mode is deliberately insufficient evidence. Ordinary
user messages, uploads and filenames cannot establish tool provenance. The
preview-only source was written exclusively by the old path-preview writer.

Names, paths, image types, object keys, random IDs, and absent promotion metadata
alone are unsafe: the old promotion writer could produce identical values.
`execution_workspace_files.metadata.promotedArtifacts` can be lost when files
are replaced or deleted; its absence is not proof. A row with ambiguous metadata
and no retained path-preview result is intentionally left alone. This backfill
therefore cannot guarantee removal of every historical inspection row. It adds
only the purpose key, preserves bytes and all other metadata, and is idempotent.
