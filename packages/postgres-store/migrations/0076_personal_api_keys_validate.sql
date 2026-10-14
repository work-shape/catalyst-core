-- In transactions of their own: each scan holds only a lock that reads and writes pass. Every
-- key a release wrote so far belongs to a service principal, so every row passes.
ALTER TABLE "api_credentials" VALIDATE CONSTRAINT "api_credentials_one_owner_check";--> statement-breakpoint
ALTER TABLE "api_credentials" VALIDATE CONSTRAINT "api_credentials_client_owner_fk";
