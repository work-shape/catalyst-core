-- A new table. Its foreign keys lock the tables they reference briefly; a busy one fails the
-- migration instead of holding up chat.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"message_id" text,
	"agent_name" text NOT NULL,
	"agent_asset_id" text,
	"agent_revision" integer,
	"agent_workspace_id" text,
	"conversation_id" text,
	"agent_run_id" text,
	"workspace_id" text,
	"author_user_id" text NOT NULL,
	"text" text NOT NULL,
	"exchange_question" text,
	"exchange_answer" text,
	"summary" text,
	"category" text,
	"annotated_at" timestamp with time zone,
	"state" text NOT NULL,
	"handled_by_user_id" text,
	"handled_by_label" text,
	"handled_at" timestamp with time zone,
	"handled_note" text,
	"approval_request_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feedback_subject_kind_check" CHECK ("feedback"."subject_kind" in ('message')),
	CONSTRAINT "feedback_state_check" CHECK ("feedback"."state" in ('new', 'handled')),
	CONSTRAINT "feedback_exchange_check" CHECK (("feedback"."exchange_question" is null) = ("feedback"."exchange_answer" is null))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_author_fk" FOREIGN KEY ("client_instance_id","author_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_run_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_asset_fk" FOREIGN KEY ("agent_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_workspace_fk" FOREIGN KEY ("agent_workspace_id") REFERENCES "public"."collaboration_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_client_message_author_idx" ON "feedback" USING btree ("client_instance_id","message_id","author_user_id") WHERE "feedback"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "feedback_client_created_idx" ON "feedback" USING btree ("client_instance_id","created_at","id");--> statement-breakpoint
CREATE INDEX "feedback_client_agent_created_idx" ON "feedback" USING btree ("client_instance_id","agent_asset_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_client_author_idx" ON "feedback" USING btree ("client_instance_id","author_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "feedback_message_idx" ON "feedback" USING btree ("message_id") WHERE "feedback"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "feedback_conversation_idx" ON "feedback" USING btree ("conversation_id") WHERE "feedback"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "feedback_agent_run_idx" ON "feedback" USING btree ("agent_run_id") WHERE "feedback"."agent_run_id" is not null;