ALTER TABLE "conversations" RENAME COLUMN "owner_user_id" TO "created_by_user_id";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "owner_external_user_id" TO "created_by_external_user_id";--> statement-breakpoint
DROP INDEX "conversations_owner_idx";--> statement-breakpoint
DROP INDEX "conversations_owner_user_idx";
