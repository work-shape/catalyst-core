CREATE TABLE "connection_bindings" (
	"connection_asset_id" text NOT NULL,
	"subject" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"user_id" text,
	"state" text NOT NULL,
	"scheme" text NOT NULL,
	"account_id" text,
	"account_label" text,
	"granted_scopes" text[] NOT NULL,
	"secret_handle" text NOT NULL,
	"secret_version" integer NOT NULL,
	"access_expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"connected_at" timestamp with time zone NOT NULL,
	"connected_by" text,
	"last_used_on" date,
	"state_changed_at" timestamp with time zone NOT NULL,
	"state_changed_by" text,
	"state_reason" text,
	"origin" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"row_version" integer NOT NULL,
	CONSTRAINT "connection_bindings_pk" PRIMARY KEY("connection_asset_id","subject"),
	CONSTRAINT "connection_bindings_state_check" CHECK ("connection_bindings"."state" in ('connected', 'needs_reconnect', 'revoked')),
	CONSTRAINT "connection_bindings_scheme_check" CHECK ("connection_bindings"."scheme" in ('oauth')),
	CONSTRAINT "connection_bindings_row_version_check" CHECK ("connection_bindings"."row_version" >= 1),
	CONSTRAINT "connection_bindings_lease_check" CHECK (("connection_bindings"."lease_owner" is null) = ("connection_bindings"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "connection_setup_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"connection_asset_id" text NOT NULL,
	"connection_revision" integer NOT NULL,
	"subject" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_key_id" text NOT NULL,
	"verifier_nonce" "bytea" NOT NULL,
	"verifier_ciphertext" "bytea" NOT NULL,
	"redirect_uri" text NOT NULL,
	"issuer" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_setup_sessions_nonce_length_check" CHECK (octet_length("connection_setup_sessions"."verifier_nonce") = 12)
);
--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "oauth_client" jsonb;--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD CONSTRAINT "connection_bindings_connection_asset_id_config_assets_id_fk" FOREIGN KEY ("connection_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setup_sessions" ADD CONSTRAINT "connection_setup_sessions_connection_asset_id_config_assets_id_fk" FOREIGN KEY ("connection_asset_id") REFERENCES "public"."config_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_bindings_client_idx" ON "connection_bindings" USING btree ("client_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_setup_sessions_state_idx" ON "connection_setup_sessions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "connection_setup_sessions_expiry_idx" ON "connection_setup_sessions" USING btree ("client_instance_id","expires_at");