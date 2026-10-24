-- LU-3: the daily sums gain the workspace (a shared workspace's id, `personal` for every
-- Personal Workspace, empty for none), the App and the Workflow, so the Usage page groups and
-- filters by them without reading usage events. The key keeps its name: a process of the
-- previous release still writes `on conflict on constraint model_usage_daily_rollups_pk`, its
-- rows land under the empty values, and the reconciliation with scope `all`, a deploy step after
-- every process runs this release, moves them to their keys.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "model_usage_daily_rollups" ADD COLUMN "workspace_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_daily_rollups" ADD COLUMN "app_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_daily_rollups" ADD COLUMN "workflow_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- No supported release before the rollups (v0.6.3) has the table; every later one names the key.
-- contract-after: v0.6.3
ALTER TABLE "model_usage_daily_rollups" DROP CONSTRAINT "model_usage_daily_rollups_pk";--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "model_usage_daily_rollups" ADD CONSTRAINT "model_usage_daily_rollups_pk" PRIMARY KEY("client_instance_id","day","provider_id","model","region","purpose","agent_name","workspace_key","app_name","workflow_name","currency");
