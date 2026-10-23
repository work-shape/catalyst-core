import type { ClientInstanceId, Logger } from "@work-shape/catalyst-core";
import { withTestSql } from "./test-sql";

/** Keep the executor's minimized failures, including fields bound by its child loggers. */
export function recordJobErrors(logs: unknown[], bound: object = {}): Logger {
  const record: Logger["error"] = (fields, message) =>
    logs.push({ fields: { ...bound, ...Object(fields) }, message });
  return {
    debug() {},
    info() {},
    warn: record,
    error: record,
    child: (fields) => recordJobErrors(logs, { ...bound, ...fields })
  };
}

/** State after a pass, without job payloads: distinguish no claim, failed attempt and not due. */
export function readJobDiagnostics(input: {
  clientInstanceIds: readonly ClientInstanceId[];
  kinds: readonly string[];
  logs: readonly unknown[];
}) {
  return withTestSql(async (sql) => ({
    jobs: await sql<
      {
        kind: string;
        status: string;
        attempts: number;
        error_code: string | null;
        error_message: string | null;
        run_after: Date;
        observed_at: Date;
        due: boolean;
      }[]
    >`
      select id, client_instance_id, kind, status, attempts, error_code, error_message, run_after,
        clock_timestamp() as observed_at, run_after <= clock_timestamp() as due
      from platform_jobs where client_instance_id = any(${[...input.clientInstanceIds]}::text[])
        and kind = any(${[...input.kinds]}::text[])
      order by kind, id`,
    logs: input.logs
  }));
}
