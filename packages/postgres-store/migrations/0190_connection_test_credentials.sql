-- DT-3: a shared Connection's test credential is a binding with subject `test` and scheme
-- `static` (ADR-0031). It names its Secret Store row by handle and version like an OAuth binding,
-- and may carry its own address in the new nullable column `endpoint`. The scheme constraint is
-- widened: every existing row and every insert of an older worker still fits it. It is added NOT
-- VALID and validated in 0191, so the table is not scanned under the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "connection_bindings" DROP CONSTRAINT "connection_bindings_scheme_check";--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD CONSTRAINT "connection_bindings_scheme_check" CHECK (("connection_bindings"."scheme" = 'oauth' and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null and "connection_bindings"."endpoint" is null)
        or ("connection_bindings"."scheme" = 'person_context' and "connection_bindings"."secret_handle" is null and "connection_bindings"."secret_version" is null and "connection_bindings"."context_header" is not null and ("connection_bindings"."context_value" is not null or "connection_bindings"."state" = 'revoked') and "connection_bindings"."subject" ~ '^person_context:(user|service_principal):.+$' and "connection_bindings"."endpoint" is null)
        or ("connection_bindings"."scheme" = 'static' and "connection_bindings"."subject" = 'test' and "connection_bindings"."user_id" is null and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null)) NOT VALID;
