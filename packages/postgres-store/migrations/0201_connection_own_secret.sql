-- PMCP-6: a person's own token on a personal MCP Connection is a binding with scheme `static`
-- and subject `user:<id>` of the person, beside the test credential's subject `test`. It names
-- its Secret Store row by handle and version. The scheme constraint is widened: every existing
-- row and every insert of an older worker still fits it. It is added NOT VALID and validated in
-- 0202, so the table is not scanned under the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "connection_bindings" DROP CONSTRAINT "connection_bindings_scheme_check";--> statement-breakpoint
ALTER TABLE "connection_bindings" ADD CONSTRAINT "connection_bindings_scheme_check" CHECK (("connection_bindings"."scheme" = 'oauth' and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null and "connection_bindings"."endpoint" is null)
        or ("connection_bindings"."scheme" = 'person_context' and "connection_bindings"."secret_handle" is null and "connection_bindings"."secret_version" is null and "connection_bindings"."context_header" is not null and ("connection_bindings"."context_value" is not null or "connection_bindings"."state" = 'revoked') and "connection_bindings"."subject" ~ '^person_context:(user|service_principal):.+$' and "connection_bindings"."endpoint" is null)
        or ("connection_bindings"."scheme" = 'static' and "connection_bindings"."subject" = 'test' and "connection_bindings"."user_id" is null and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null)
        or ("connection_bindings"."scheme" = 'static' and "connection_bindings"."user_id" is not null and "connection_bindings"."subject" = 'user:' || "connection_bindings"."user_id" and "connection_bindings"."state" in ('connected', 'needs_reconnect') and "connection_bindings"."secret_handle" is not null and "connection_bindings"."secret_version" is not null and "connection_bindings"."context_header" is null and "connection_bindings"."context_value" is null and "connection_bindings"."endpoint" is null)) NOT VALID;
