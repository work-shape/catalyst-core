CREATE SEQUENCE "messages_storage_ordinal_seq";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "storage_ordinal" bigint;
--> statement-breakpoint
ALTER SEQUENCE "messages_storage_ordinal_seq" OWNED BY "messages"."storage_ordinal";
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "storage_ordinal" SET DEFAULT nextval('"messages_storage_ordinal_seq"');
--> statement-breakpoint
WITH "ranked_messages" AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "storage_ordinal"
	FROM "messages"
)
UPDATE "messages"
SET "storage_ordinal" = "ranked_messages"."storage_ordinal"
FROM "ranked_messages"
WHERE "messages"."id" = "ranked_messages"."id";
--> statement-breakpoint
SELECT setval(
	'"messages_storage_ordinal_seq"',
	GREATEST(COALESCE((SELECT max("storage_ordinal") FROM "messages"), 0) + 1, 1),
	false
);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "storage_ordinal" SET NOT NULL;
