-- Two-factor sign-in for password accounts (TWO-FACTOR-1): a new table, empty, and a column on
-- the sign-in library's "user" with a constant default, so no row is rewritten and every
-- existing account starts without a factor. The column and the foreign key lock "user" briefly,
-- and every signed-in request reads it; a busy table fails the migration instead of holding up
-- sign-in.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");