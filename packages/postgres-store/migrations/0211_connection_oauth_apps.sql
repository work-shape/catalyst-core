-- OAUTH-APP: an instance's OAuth app, one per authorization server, entered once by an admin.
-- A new table, no backfill: a Connection's own client secret stays in `secrets` until the
-- adopting write or someone removes it, and keeps winning over the app until then.
CREATE TABLE "connection_oauth_apps" (
	"client_instance_id" text NOT NULL,
	"server" text NOT NULL,
	"service" text,
	"client_id" text NOT NULL,
	"version" integer NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_oauth_apps_pk" PRIMARY KEY("client_instance_id","server"),
	CONSTRAINT "connection_oauth_apps_nonce_length_check" CHECK (octet_length("connection_oauth_apps"."nonce") = 12),
	CONSTRAINT "connection_oauth_apps_version_check" CHECK ("connection_oauth_apps"."version" >= 1)
);
