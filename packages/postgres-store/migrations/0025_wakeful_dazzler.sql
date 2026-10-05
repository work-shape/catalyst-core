CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_by" jsonb NOT NULL,
	"origin" jsonb,
	"status" text NOT NULL,
	"decision" jsonb,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apply_result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "approval_requests_client_status_idx" ON "approval_requests" USING btree ("client_instance_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_requests_client_conversation_idx" ON "approval_requests" USING btree ("client_instance_id",("origin"->>'conversationId'));