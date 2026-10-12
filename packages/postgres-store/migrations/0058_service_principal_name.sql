-- The default stays: a release that does not know the column runs beside this one during a
-- deploy, and the principals it creates get a random name. Every existing row gets one here too.
ALTER TABLE "service_principals" ADD COLUMN "name" text DEFAULT ('principal-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12)) NOT NULL;--> statement-breakpoint
-- An existing principal is named after its label: the label as a slug of at most 48 characters.
-- Where two principals of one instance have the same slug, the oldest keeps it. Each other one
-- gets the start of the slug and a tail made of its id, 49 characters long. Such a name is at
-- least 50 characters, so it equals no slug, and two of them are equal only for one id.
UPDATE "service_principals"
SET "name" = CASE
  WHEN "ranked"."position" = 1 THEN "ranked"."slug"
  ELSE left("ranked"."slug", 14) || '-' || md5("ranked"."id") || '-' || substr(md5('name:' || "ranked"."id"), 1, 15)
END
FROM (
  SELECT
    "slugs"."id",
    "slugs"."slug",
    row_number() OVER (
      PARTITION BY "slugs"."client_instance_id", "slugs"."slug"
      ORDER BY "slugs"."created_at", "slugs"."id"
    ) AS "position"
  FROM (
    SELECT
      "id",
      "client_instance_id",
      "created_at",
      coalesce(
        nullif(
          rtrim(left(ltrim(regexp_replace(lower("display_label"), '[^a-z0-9]+', '-', 'g'), '-'), 48), '-'),
          ''
        ),
        'principal'
      ) AS "slug"
    FROM "service_principals"
  ) AS "slugs"
) AS "ranked"
WHERE "service_principals"."id" = "ranked"."id";
