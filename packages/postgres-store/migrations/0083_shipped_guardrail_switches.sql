-- GR-PUB-1: a shipped guardrail without a row is on, so every existing instance has "Publishing needs an
-- instance admin's approval" on from this migration. A row is written only by an instance admin's switch.
CREATE TABLE "shipped_guardrail_switches" (
	"client_instance_id" text NOT NULL,
	"guardrail_name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"switched_by_id" text NOT NULL,
	"switched_by_label" text NOT NULL,
	"switched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipped_guardrail_switches_pk" PRIMARY KEY("client_instance_id","guardrail_name")
);
