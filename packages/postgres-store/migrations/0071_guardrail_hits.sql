CREATE TABLE "guardrail_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"guardrail_name" text NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"message" text NOT NULL,
	"subject_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "guardrail_hits_client_guardrail_created_idx" ON "guardrail_hits" USING btree ("client_instance_id","guardrail_name","created_at","id");