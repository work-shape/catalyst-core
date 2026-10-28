-- Expand only: previous releases continue using null server_request (browser captures).
-- Nullable columns require a brief metadata lock; refuse instead of waiting behind traffic.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "preview_captures" ADD COLUMN "server_request" jsonb;--> statement-breakpoint
ALTER TABLE "preview_captures" ADD COLUMN "server_diagnostics" jsonb;
