CREATE TABLE "knowledge_base_states" (
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"tables" jsonb NOT NULL,
	"problem" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_base_states_client_instance_id_asset_id_pk" PRIMARY KEY("client_instance_id","asset_id"),
	CONSTRAINT "knowledge_base_states_status_check" CHECK ("knowledge_base_states"."status" in ('ok', 'needs_attention'))
);
