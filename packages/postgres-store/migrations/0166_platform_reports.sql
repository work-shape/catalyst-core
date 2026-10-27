-- Who reported which failed run to the operator (PLATFORM-REPORT): a new, empty table that
-- holds ids and a code, never a note. Its foreign key locks product_users briefly; a busy table
-- fails the migration instead of holding up sign-ins.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "platform_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"error_code" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_reports" ADD CONSTRAINT "platform_reports_author_fk" FOREIGN KEY ("client_instance_id","author_user_id") REFERENCES "public"."product_users"("client_instance_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_reports_run_author_idx" ON "platform_reports" USING btree ("client_instance_id","agent_run_id","author_user_id");--> statement-breakpoint
CREATE INDEX "platform_reports_author_created_idx" ON "platform_reports" USING btree ("client_instance_id","author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_reports_created_idx" ON "platform_reports" USING btree ("client_instance_id","created_at");