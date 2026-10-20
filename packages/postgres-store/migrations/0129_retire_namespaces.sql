-- NS-RETIRE in one step (Felix, 2026-10-19: no production instance holds a Namespace). Every
-- Namespace right becomes what it covers today, on the rows that cover it without a Namespace,
-- and nobody gains a right:
--
-- * A Namespace allow becomes an allow on each active asset of the instance whose kind is the
--   action's and whose name starts with the prefix: exactly the assets it covers now. An asset
--   made later under the prefix is not covered; that narrows and never widens. A workspace
--   owns none of these assets, so no workspace row is their equivalent.
-- * A Namespace deny stops the migration, naming its instance, holder, action and prefix. It
--   refuses names nobody has made yet, which no row on an asset or a workspace refuses, so it
--   has no equivalent that keeps every refusal. An administrator replaces it on the release
--   before (a deny on the asset or the workspace) and revokes it; then the migration runs.
-- * A key scope with a Namespace part (`agent.write:kai-`) is taken out of its key. No scope
--   names an instance asset without covering every one, so nothing narrower can replace it. A
--   key left with none covers nothing.
--
-- Each change leaves the audit event an administrator's own change leaves, with no actor and
-- the reason `namespace_retired`.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
DO $$
DECLARE
	denies text;
BEGIN
	SELECT string_agg(
		format(
			'instance %s, %s %s, %s in Namespace %s',
			"client_instance_id", "holder_kind", "holder_id", "action", "namespace"
		),
		'; '
		ORDER BY "client_instance_id", "namespace", "holder_kind", "holder_id", "action"
	)
	INTO denies
	FROM "permission_grants"
	WHERE "scope_kind" = 'namespace' AND "effect" = 'deny';

	IF denies IS NOT NULL THEN
		RAISE EXCEPTION 'NS-RETIRE stops: a Namespace deny would stop applying. Deny the same on the workspace or the asset, revoke the Namespace deny on Instance > Access of the release before, and run the migration again. Namespace denies: %', denies;
	END IF;
END $$;
--> statement-breakpoint
-- An asset row the holder has already, an allow or a deny, stays as it is.
-- contract-after: v0.6.3
WITH "mapped" AS (
	INSERT INTO "permission_grants" (
		"id", "client_instance_id", "holder_kind", "holder_id", "action", "effect", "scope_kind",
		"scope_id", "granted_by", "created_at"
	)
	SELECT
		'grant_' || gen_random_uuid()::text,
		g."client_instance_id",
		g."holder_kind",
		g."holder_id",
		g."action",
		'allow',
		'asset',
		a."id",
		g."granted_by",
		now()
	FROM "permission_grants" g
	JOIN "config_assets" a
		ON a."client_instance_id" = g."client_instance_id"
		AND a."kind" = split_part(g."action", '.', 1)
		AND a."scope_kind" = 'instance'
		AND a."status" = 'active'
		AND starts_with(a."name", g."namespace")
	WHERE g."scope_kind" = 'namespace' AND g."effect" = 'allow'
	ON CONFLICT DO NOTHING
	RETURNING *
)
INSERT INTO "audit_events" (
	"id", "client_instance_id", "type", "status", "actor", "subject", "reason",
	"correlation_id", "created_at", "metadata"
)
SELECT
	'audit_' || gen_random_uuid()::text,
	"client_instance_id",
	'permission.granted',
	'success',
	NULL,
	"id",
	'namespace_retired',
	'migration:0129_retire_namespaces',
	now(),
	jsonb_build_object(
		'grantId', "id",
		'holderKind', "holder_kind",
		'holderId', "holder_id",
		'action', "action",
		'effect', "effect",
		'scopeKind', "scope_kind",
		'scopeId', "scope_id"
	) || CASE
		WHEN "holder_kind" = 'service_principal'
			THEN jsonb_build_object('servicePrincipalId', "holder_id")
		ELSE '{}'::jsonb
	END
FROM "mapped";
--> statement-breakpoint
INSERT INTO "audit_events" (
	"id", "client_instance_id", "type", "status", "actor", "subject", "reason",
	"correlation_id", "created_at", "metadata"
)
SELECT
	'audit_' || gen_random_uuid()::text,
	"client_instance_id",
	'permission.revoked',
	'success',
	NULL,
	"id",
	'namespace_retired',
	'migration:0129_retire_namespaces',
	now(),
	jsonb_build_object(
		'grantId', "id",
		'holderKind', "holder_kind",
		'holderId', "holder_id",
		'action', "action",
		'effect', "effect",
		'scopeKind', "scope_kind",
		'namespace', "namespace"
	) || CASE
		WHEN "holder_kind" = 'service_principal'
			THEN jsonb_build_object('servicePrincipalId', "holder_id")
		ELSE '{}'::jsonb
	END
FROM "permission_grants"
WHERE "scope_kind" = 'namespace';
--> statement-breakpoint
INSERT INTO "audit_events" (
	"id", "client_instance_id", "type", "status", "actor", "subject", "reason",
	"correlation_id", "created_at", "metadata"
)
SELECT
	'audit_' || gen_random_uuid()::text,
	"client_instance_id",
	'namespace.deleted',
	'success',
	NULL,
	"prefix",
	'namespace_retired',
	'migration:0129_retire_namespaces',
	now(),
	jsonb_build_object(
		'prefix', "prefix",
		'restrictsTools', "allowed_tool_names" IS NOT NULL,
		'restrictsModels', "allowed_model_binding_ids" IS NOT NULL
	)
FROM "namespaces";
--> statement-breakpoint
-- A Namespace part is a prefix: lowercase words joined by hyphens, ending in one. A workspace
-- id never ends in a hyphen.
-- contract-after: v0.6.3
WITH "before" AS (
	SELECT
		c."id",
		(
			SELECT coalesce(jsonb_agg(scope.value ORDER BY scope.position), '[]'::jsonb)
			FROM jsonb_array_elements_text(c."scopes") WITH ORDINALITY AS scope(value, position)
			WHERE scope.value !~ ':[a-z][a-z0-9]*(-[a-z0-9]+)*-$'
		) AS "kept",
		(
			SELECT jsonb_agg(scope.value ORDER BY scope.position)
			FROM jsonb_array_elements_text(c."scopes") WITH ORDINALITY AS scope(value, position)
			WHERE scope.value ~ ':[a-z][a-z0-9]*(-[a-z0-9]+)*-$'
		) AS "removed"
	FROM "api_credentials" c
	WHERE c."owner_user_id" IS NOT NULL
		AND jsonb_typeof(c."scopes") = 'array'
		AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements_text(c."scopes") AS scope(value)
			WHERE scope.value ~ ':[a-z][a-z0-9]*(-[a-z0-9]+)*-$'
		)
),
"narrowed" AS (
	UPDATE "api_credentials" c
	SET "scopes" = b."kept"
	FROM "before" b
	WHERE c."id" = b."id"
	RETURNING c."id", c."client_instance_id", c."owner_user_id", b."kept", b."removed"
)
INSERT INTO "audit_events" (
	"id", "client_instance_id", "type", "status", "actor", "subject", "reason",
	"correlation_id", "created_at", "metadata"
)
SELECT
	'audit_' || gen_random_uuid()::text,
	"client_instance_id",
	'api_access.personal_key_narrowed',
	'success',
	NULL,
	"id",
	'namespace_retired',
	'migration:0129_retire_namespaces',
	now(),
	jsonb_build_object(
		'keyId', "id",
		'ownerUserId', "owner_user_id",
		'removedScopes', "removed",
		'remainingScopeCount', jsonb_array_length("kept")
	)
FROM "narrowed";
--> statement-breakpoint
-- Only allows are left: the first statement stopped at any deny.
-- contract-after: v0.6.3
DELETE FROM "permission_grants" WHERE "scope_kind" = 'namespace';
--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "namespaces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- contract-after: v0.6.3
DROP TABLE "namespaces" CASCADE;--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "permission_grants" DROP CONSTRAINT "permission_grants_namespace_check";--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "permission_grants" DROP CONSTRAINT "permission_grants_scope_kind_check";--> statement-breakpoint
-- Validated by 0131, once the column is gone.
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_scope_kind_check" CHECK ("permission_grants"."scope_kind" in ('instance', 'workspace', 'asset')) NOT VALID;
