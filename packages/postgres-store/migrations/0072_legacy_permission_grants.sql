-- AP-4: the legacy permission lists become grant rows, and a credential without a scope list
-- gets `["*"]`. Nothing is removed: the columns `permissions` of `product_users` and
-- `service_principals` keep what they hold, are read and written by no code of this release,
-- and are dropped by a later migration once this release is the oldest supported one. Rolling
-- back to a release before this one: `scripts/verify-permissions.ts --restore-legacy-columns`
-- writes the rows back into the columns, removes them, turns `["*"]` back to null and removes
-- the record of this migration, then the old release starts. The next upgrade runs this
-- migration again, over the lists the old release kept.
--
-- Each key of a list becomes one instance-wide row per action it stands for
-- (`LEGACY_PERMISSION_ACTIONS` in `core/src/permissions.ts`): an allow for `key`, a deny for
-- `!key`. A list with both holds the deny, as the list did. An entry that is not one of the nine
-- keys gave no right and gives no row. A user whose deletion was requested holds nothing and
-- gets no row. A row the holder already has for that action keeps who wrote it; a legacy
-- revocation still makes it a deny, because the revocation refused the action before.
INSERT INTO "permission_grants" (
  "id", "client_instance_id", "holder_kind", "holder_id", "action", "scope_kind", "scope_id",
  "namespace", "effect", "granted_by", "created_at"
)
SELECT
  'grant_' || gen_random_uuid()::text,
  "held"."client_instance_id",
  "held"."holder_kind",
  "held"."holder_id",
  "legacy_keys"."action",
  'instance',
  NULL,
  NULL,
  CASE WHEN "held"."permissions" @> jsonb_build_array('!' || "legacy_keys"."key") THEN 'deny' ELSE 'allow' END,
  'legacy_permission_list',
  now()
FROM (
  SELECT 'user' AS "holder_kind", "id" AS "holder_id", "client_instance_id", "permissions"
  FROM "product_users"
  WHERE "deletion_requested_at" IS NULL AND jsonb_typeof("permissions") = 'array'
  UNION ALL
  SELECT 'service_principal', "id", "client_instance_id", "permissions"
  FROM "service_principals"
  WHERE jsonb_typeof("permissions") = 'array'
) AS "held"
JOIN (
  VALUES
    ('agent_skills.approve', 'skill.approve'),
    ('agent_skills.approve', 'operations.approve'),
    ('config_assets.read', 'agent.read'),
    ('config_assets.read', 'skill.read'),
    ('config_assets.write', 'agent.write'),
    ('config_assets.write', 'agent.delete'),
    ('config_assets.write', 'skill.write'),
    ('config_assets.write', 'skill.delete'),
    ('config_assets.release', 'assets.release'),
    ('usage.view', 'usage.view'),
    ('users.manage', 'users.manage'),
    ('api_access.manage', 'api_access.manage'),
    ('agent_models.manage', 'agent_models.manage'),
    ('audit.view', 'audit.view')
) AS "legacy_keys" ("key", "action")
  ON "held"."permissions" @> jsonb_build_array("legacy_keys"."key")
  OR "held"."permissions" @> jsonb_build_array('!' || "legacy_keys"."key")
ON CONFLICT ("client_instance_id", "holder_kind", "holder_id", "action", "scope_kind", coalesce("scope_id", ''), coalesce("namespace", ''))
DO UPDATE SET "effect" = 'deny'
WHERE "excluded"."effect" = 'deny' AND "permission_grants"."effect" <> 'deny';--> statement-breakpoint
-- Before this release `*` in a credential's list gave no scope, and from this release it gives
-- every scope of the principal. It is taken out of the lists that have it, so they keep meaning
-- what they meant. No credential could be given `*` through the API, so none is expected. The
-- comment this migration puts on the column at its end says the lists were read so: run once
-- more, the migration keeps the `["*"]` it wrote.
UPDATE "api_credentials"
SET "scopes" = coalesce(
  (
    SELECT jsonb_agg("entry"."value" ORDER BY "entry"."position")
    FROM jsonb_array_elements("api_credentials"."scopes") WITH ORDINALITY AS "entry" ("value", "position")
    WHERE "entry"."value" <> '"*"'::jsonb
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof("scopes") = 'array' AND "scopes" @> '["*"]'::jsonb
  AND col_description(
    '"api_credentials"'::regclass,
    (SELECT "attnum" FROM pg_attribute WHERE "attrelid" = '"api_credentials"'::regclass AND "attname" = 'scopes')
  ) IS DISTINCT FROM 'The scopes the credential carries of its principal''s; ["*"] carries every one (AP-4).';--> statement-breakpoint
-- A credential without a list had every scope of its principal; `["*"]` says so. An empty list
-- gives no scope and stays empty. The column becomes required in a later migration: a release
-- before this one writes null for such a credential and may run beside this one in a deploy.
UPDATE "api_credentials"
SET "scopes" = '["*"]'::jsonb
WHERE "scopes" IS NULL OR "scopes" = 'null'::jsonb;--> statement-breakpoint
COMMENT ON COLUMN "api_credentials"."scopes" IS 'The scopes the credential carries of its principal''s; ["*"] carries every one (AP-4).';
