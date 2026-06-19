ALTER TABLE "conversation_attachments" ADD COLUMN "artifact_refs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD COLUMN "processing_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "conversation_attachments"
SET "artifact_refs" = jsonb_strip_nulls(
    jsonb_build_object(
      'document.prepared_text', "prepared_text_artifact_id",
      'document.pages_json', "prepared_pages_artifact_id"
    )
  ),
  "processing_metadata" = jsonb_strip_nulls(
    jsonb_build_object(
      'preprocessingEngine', "preprocessing_engine",
      'characterCount', "character_count",
      'wordCount', "word_count",
      'pageCount', "page_count"
    )
  )
WHERE "prepared_text_artifact_id" IS NOT NULL
  OR "prepared_pages_artifact_id" IS NOT NULL
  OR "preprocessing_engine" IS NOT NULL
  OR "character_count" IS NOT NULL
  OR "word_count" IS NOT NULL
  OR "page_count" IS NOT NULL;
