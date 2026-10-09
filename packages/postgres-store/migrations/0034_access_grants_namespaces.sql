CREATE TABLE "namespaces" (
	"client_instance_id" text NOT NULL,
	"prefix" text NOT NULL,
	"display_name" text NOT NULL,
	"allowed_tool_names" jsonb,
	"allowed_model_binding_ids" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "namespaces_pk" PRIMARY KEY("client_instance_id","prefix")
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_instance_id" text NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"action" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"namespace" text,
	"effect" text DEFAULT 'allow' NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_grants_holder_kind_check" CHECK ("permission_grants"."holder_kind" in ('user', 'service_principal', 'role', 'group')),
	CONSTRAINT "permission_grants_scope_kind_check" CHECK ("permission_grants"."scope_kind" in ('instance', 'workspace', 'namespace', 'asset')),
	CONSTRAINT "permission_grants_effect_check" CHECK ("permission_grants"."effect" in ('allow', 'deny')),
	CONSTRAINT "permission_grants_namespace_check" CHECK (("permission_grants"."scope_kind" = 'namespace') = ("permission_grants"."namespace" is not null)),
	CONSTRAINT "permission_grants_scope_id_check" CHECK (("permission_grants"."scope_kind" in ('workspace', 'asset')) = ("permission_grants"."scope_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_unique" ON "permission_grants" USING btree ("client_instance_id","holder_kind","holder_id","action","scope_kind",coalesce("scope_id", ''),coalesce("namespace", ''));--> statement-breakpoint
CREATE INDEX "permission_grants_holder" ON "permission_grants" USING btree ("client_instance_id","holder_kind","holder_id");