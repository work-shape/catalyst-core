-- PMCP-6: validates the widened scheme constraint of 0201 without blocking writes to the table.
ALTER TABLE "connection_bindings" VALIDATE CONSTRAINT "connection_bindings_scheme_check";
