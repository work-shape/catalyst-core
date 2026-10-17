ALTER TABLE "agent_change_proposals" ADD COLUMN "last_author_user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_change_proposals" ADD COLUMN "last_build_conversation_id" text;
--> statement-breakpoint
ALTER TABLE "agent_change_proposals" ADD COLUMN "last_write_release" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Choose a pending head first, newest updated_at then id. An agent without a pending head
-- retains its newest counter row, so a discarded/applied revision number never repeats.
-- The data movement is one statement: readers cannot see a partially collapsed draft.
-- No supported stable release uses proposals. rc.3 rollback caveat is in the change file.
-- contract-after: v0.6.3
WITH ranked AS MATERIALIZED (
  SELECT p.id, p.agent_id, p.revision,
    max(p.revision) OVER (PARTITION BY p.agent_id) AS highest,
    row_number() OVER (PARTITION BY p.agent_id ORDER BY
      EXISTS (SELECT 1 FROM agent_change_proposal_revisions r
              WHERE r.proposal_id = p.id AND r.revision = p.revision) DESC,
      p.updated_at DESC, p.id DESC) AS position
  FROM agent_change_proposals p
), copied AS (
  INSERT INTO agent_change_proposal_revisions (proposal_id, revision, config, created_at)
  SELECT r.proposal_id, k.highest, r.config, r.created_at
  FROM ranked k JOIN agent_change_proposal_revisions r ON r.proposal_id = k.id AND r.revision = k.revision
  WHERE k.position = 1 AND k.highest > k.revision
  RETURNING proposal_id
), updated AS (
  UPDATE agent_change_proposals p SET revision = k.highest,
    last_author_user_id = CASE WHEN p.source_kind = 'person' THEN p.source_id
      ELSE (SELECT c.created_by_user_id FROM conversations c WHERE c.id = p.source_id) END,
    last_build_conversation_id = CASE WHEN p.source_kind = 'conversation' THEN p.source_id ELSE NULL END
  FROM ranked k WHERE p.id = k.id AND k.position = 1
  RETURNING p.id
)
DELETE FROM agent_change_proposals p USING ranked k WHERE p.id = k.id AND k.position > 1;

