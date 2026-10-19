CREATE TABLE "scope_assignments" (
	"client_instance_id" text NOT NULL,
	"dimension" text NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"effect" text NOT NULL,
	"values" jsonb NOT NULL,
	CONSTRAINT "scope_assignments_pk" PRIMARY KEY("client_instance_id","holder_kind","holder_id","dimension","effect"),
	CONSTRAINT "scope_assignments_holder_kind" CHECK ("scope_assignments"."holder_kind" in ('user', 'group', 'service_principal')),
	CONSTRAINT "scope_assignments_effect" CHECK ("scope_assignments"."effect" in ('allow', 'deny')),
	CONSTRAINT "scope_assignments_values" CHECK (jsonb_typeof("scope_assignments"."values") = 'array' or "scope_assignments"."values" = '"all"'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "product_users" ADD COLUMN "groups" jsonb DEFAULT '[]'::jsonb NOT NULL;