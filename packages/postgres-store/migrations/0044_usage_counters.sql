CREATE TABLE "model_usage_counters" (
	"client_instance_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"period_kind" text NOT NULL,
	"period_start" date NOT NULL,
	"model_call_count" bigint DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "model_usage_counters_pk" PRIMARY KEY("client_instance_id","scope_kind","scope_id","period_kind","period_start")
);
--> statement-breakpoint
CREATE TABLE "model_usage_daily_rollups" (
	"client_instance_id" text NOT NULL,
	"day" date NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"region" text NOT NULL,
	"purpose" text NOT NULL,
	"agent_name" text NOT NULL,
	"currency" text NOT NULL,
	"model_call_count" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_call_count" bigint DEFAULT 0 NOT NULL,
	"settled_model_call_count" bigint DEFAULT 0 NOT NULL,
	"uncached_input_cost_micros" bigint DEFAULT 0 NOT NULL,
	"cached_input_cost_micros" bigint DEFAULT 0 NOT NULL,
	"output_cost_micros" bigint DEFAULT 0 NOT NULL,
	"web_search_cost_micros" bigint DEFAULT 0 NOT NULL,
	"settled_web_search_call_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "model_usage_daily_rollups_pk" PRIMARY KEY("client_instance_id","day","provider_id","model","region","purpose","agent_name","currency")
);
--> statement-breakpoint
CREATE TABLE "model_usage_maintenance" (
	"client_instance_id" text NOT NULL,
	"task" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_usage_maintenance_pk" PRIMARY KEY("client_instance_id","task")
);
--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "status" text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "counted_tokens" bigint;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "counted_cost_micros" bigint;
