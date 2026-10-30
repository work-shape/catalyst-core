-- DT-3: validates the widened scheme constraint of 0190 without blocking writes to the table.
ALTER TABLE "connection_bindings" VALIDATE CONSTRAINT "connection_bindings_scheme_check";
