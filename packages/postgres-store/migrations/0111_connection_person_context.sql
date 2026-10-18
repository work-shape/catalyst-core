-- Widen the OAuth-only constraint. Every old OAuth row and old-worker insert still fits.
-- The oldest supported release predates this binding table; no column or OAuth invariant is removed.
-- contract-after: v0.6.3
ALTER TABLE "connection_bindings" DROP CONSTRAINT "connection_bindings_scheme_check";--> statement-breakpoint
ALTER TABLE "connection_bindings" ALTER COLUMN "secret_handle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_bindings" ALTER COLUMN "secret_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD COLUMN "context_header" text;--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD COLUMN "context_value" text;--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD CONSTRAINT "connection_bindings_scheme_check" CHECK (("connection_bindings"."scheme" = 'oauth' and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null)
        or ("connection_bindings"."scheme" = 'person_context' and "connection_bindings"."secret_handle" is null and "connection_bindings"."secret_version" is null and "connection_bindings"."context_header" is not null and ("connection_bindings"."context_value" is not null or "connection_bindings"."state" = 'revoked') and "connection_bindings"."subject" ~ '^person_context:(user|service_principal):.+$')) NOT VALID;
