CREATE TABLE "roles" (
	"client_instance_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"built_in" boolean NOT NULL,
	"default_actions" jsonb,
	"pending_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_pk" PRIMARY KEY("client_instance_id","id"),
	CONSTRAINT "roles_built_in_check" CHECK (not "roles"."built_in" or "roles"."id" in ('user', 'admin')),
	CONSTRAINT "roles_default_actions_check" CHECK ("roles"."built_in" = ("roles"."default_actions" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_unique" ON "roles" USING btree ("client_instance_id","name");