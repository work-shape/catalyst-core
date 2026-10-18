CREATE TABLE "knowledge_source_boundary_changes" (
	"client_instance_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "knowledge_source_boundary_changes_client_instance_id_asset_id_source_id_pk" PRIMARY KEY("client_instance_id","asset_id","source_id")
);
