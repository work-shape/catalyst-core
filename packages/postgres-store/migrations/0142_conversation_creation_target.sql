-- Where a conversation's first saves create an agent, skill or guardrail (studio-chat-entry.md,
-- section 4a). A nullable column without a default adds no rewrite. The check is added without
-- reading the table under the brief lock, then validated without blocking writes; every
-- existing row holds null.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "creation_target" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creation_target_check" CHECK ("conversations"."creation_target" is null or "conversations"."creation_target" = 'instance') NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_creation_target_check";
