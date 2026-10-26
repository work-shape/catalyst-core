-- The public host of the capability outside-forms connects with a database role of its own
-- (EW-9). Row-level security keeps every role whose name starts with catalyst_outside_forms to
-- the rows of that capability, for reading and for writing. The platform's role owns the table,
-- or is a superuser, and is not subject to it. Every other role keeps what its grants give
-- through the permissive policy, so no release that reads this table changes; that is why each
-- statement may run before v0.6.3 leaves support. Neither policy names a role: the migration
-- needs no role to exist and no CREATEROLE. Each statement takes the table's lock briefly.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- contract-after: v0.6.3
ALTER TABLE "capability_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- contract-after: v0.6.3
CREATE POLICY "capability_records_by_grant" ON "capability_records" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- contract-after: v0.6.3
CREATE POLICY "capability_records_outside_forms_host" ON "capability_records" AS RESTRICTIVE FOR ALL TO public USING (capability = 'outside-forms' or not starts_with(current_user::text, 'catalyst_outside_forms')) WITH CHECK (capability = 'outside-forms' or not starts_with(current_user::text, 'catalyst_outside_forms'));
