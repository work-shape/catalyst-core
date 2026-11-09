-- When a person or their agent gave a conversation its title. The title job replaces none given.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title_given_at" timestamp with time zone;