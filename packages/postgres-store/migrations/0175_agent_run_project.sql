-- PRJ-3: a run records the project its chat was in and the version of the project's AGENTS.md
-- it took. Two nullable columns without a default change no row; the table's lock is brief.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "project_instructions_version" integer;