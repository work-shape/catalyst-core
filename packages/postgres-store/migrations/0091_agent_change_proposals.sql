CREATE TABLE "agent_change_proposal_revisions" (
	"proposal_id" text NOT NULL,
	"revision" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_change_proposal_revisions_pk" PRIMARY KEY("proposal_id","revision")
);
--> statement-breakpoint
CREATE TABLE "agent_change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_change_proposals_source_kind_check" CHECK ("agent_change_proposals"."source_kind" in ('conversation', 'person'))
);
--> statement-breakpoint
ALTER TABLE "agent_change_proposal_revisions" ADD CONSTRAINT "agent_change_proposal_revisions_proposal_id_agent_change_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."agent_change_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_change_proposals" ADD CONSTRAINT "agent_change_proposals_agent_id_config_assets_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_change_proposals_source_idx" ON "agent_change_proposals" USING btree ("agent_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "agent_change_proposals_of_source_idx" ON "agent_change_proposals" USING btree ("client_instance_id","source_kind","source_id");