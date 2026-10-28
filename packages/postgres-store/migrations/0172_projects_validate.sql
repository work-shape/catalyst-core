-- Projects (PRJ-1). In a transaction of its own: the scan holds only a lock that reads and
-- writes pass. Every existing conversation holds no project, so both checks pass.
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_project_id_config_assets_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_project_chat_check";
