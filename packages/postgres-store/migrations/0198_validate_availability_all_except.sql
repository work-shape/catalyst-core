-- Validates the widened availability mode constraint of 0197 without blocking writes to the table.
ALTER TABLE "config_asset_availability" VALIDATE CONSTRAINT "config_asset_availability_mode_check";
