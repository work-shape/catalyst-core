-- Validates the widened approval constraint of 0194 without blocking writes to the table.
ALTER TABLE "api_connect_codes" VALIDATE CONSTRAINT "api_connect_codes_approval_check";
