-- A personal API key may be issued without an expiry: its `api_credentials.expires_at` stays
-- null, which the column already allows. A connect code confirmed for such a key keeps
-- `key_expires_at` null after its approval, so the approval constraint no longer ties that
-- column to `approved_at`. The constraint is widened: every existing row and every write of an
-- older release still fits it. It is added NOT VALID and validated in 0195, so the table is not
-- scanned under the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "api_connect_codes" DROP CONSTRAINT "api_connect_codes_approval_check";--> statement-breakpoint
ALTER TABLE "api_connect_codes" ADD CONSTRAINT "api_connect_codes_approval_check" CHECK (("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."owner_user_id" is null) and ("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."key_scopes" is null) and ("api_connect_codes"."approved_at" is null) = ("api_connect_codes"."key_name" is null) and ("api_connect_codes"."approved_at" is not null or "api_connect_codes"."key_expires_at" is null)) NOT VALID;
