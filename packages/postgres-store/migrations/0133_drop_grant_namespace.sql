-- The Namespace column goes with the index that named it; `permission_grants_scope_unique`
-- (0130) guards the rows from here. Then the narrowed scope kinds of 0129 are validated.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
DROP INDEX "permission_grants_unique";--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "permission_grants" DROP COLUMN "namespace";--> statement-breakpoint
ALTER TABLE "permission_grants" VALIDATE CONSTRAINT "permission_grants_scope_kind_check";
