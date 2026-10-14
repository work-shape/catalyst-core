-- In a transaction of its own: the scan holds only a lock that reads and writes pass.
ALTER TABLE "operation_runs" VALIDATE CONSTRAINT "operation_runs_target_check";
