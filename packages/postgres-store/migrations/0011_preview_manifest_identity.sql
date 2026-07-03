ALTER TABLE "artifact_preview_manifests"
  ADD COLUMN IF NOT EXISTS "renderer" text DEFAULT 'artifact-preview-worker' NOT NULL;

ALTER TABLE "artifact_preview_manifests"
  ADD COLUMN IF NOT EXISTS "renderer_version" text DEFAULT 'preview-contract-v1' NOT NULL;

ALTER TABLE "artifact_preview_manifests"
  ADD COLUMN IF NOT EXISTS "settings_hash" text DEFAULT 'default-image-pages-v1' NOT NULL;

ALTER TABLE "artifact_preview_manifests"
  DROP CONSTRAINT IF EXISTS "artifact_preview_manifests_pk";

ALTER TABLE "artifact_preview_manifests"
  ADD CONSTRAINT "artifact_preview_manifests_pk"
  PRIMARY KEY (
    "client_instance_id",
    "source_artifact_id",
    "renderer",
    "renderer_version",
    "settings_hash"
  );

ALTER TABLE "artifact_preview_manifests"
  ALTER COLUMN "renderer" DROP DEFAULT;

ALTER TABLE "artifact_preview_manifests"
  ALTER COLUMN "renderer_version" DROP DEFAULT;

ALTER TABLE "artifact_preview_manifests"
  ALTER COLUMN "settings_hash" DROP DEFAULT;
