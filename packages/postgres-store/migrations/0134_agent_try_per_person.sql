-- Keep the legacy Build column nullable while old workers drain. New previews never set it.
ALTER TABLE "agent_try_conversations" ALTER COLUMN "build_conversation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_try_conversations" ADD COLUMN "created_by_user_id" text;
--> statement-breakpoint
UPDATE agent_try_conversations t SET created_by_user_id = c.created_by_user_id
FROM conversations c WHERE c.id = t.conversation_id;
--> statement-breakpoint
-- Preserve every replaced conversation for retention cleanup; newest wins for each person.
UPDATE agent_try_conversations t SET replaced_at = now()
FROM (
  SELECT conversation_id, row_number() OVER (
    PARTITION BY client_instance_id, agent_id, created_by_user_id
    ORDER BY created_at DESC, conversation_id DESC
  ) AS position FROM agent_try_conversations WHERE replaced_at IS NULL
) r WHERE r.conversation_id = t.conversation_id AND r.position > 1;
--> statement-breakpoint
-- Detach existing previews so deleting their former Build conversation cannot cascade.
UPDATE agent_try_conversations SET build_conversation_id = NULL;
