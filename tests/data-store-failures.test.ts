import { describe, expect, it } from "vitest";
import { describeDatabaseFailure } from "../packages/data-stores/src/failures";
import { toPostgresExecutorError } from "../packages/postgres-connector/src/executor/errors";

// What a store's database failing is told as, where the failure is the statement's own and no
// absence of the server. A query of a Data Store or a Knowledge Base that sorts past the
// store role's `temp_file_limit` reached its caller as a bare 500.

describe("a failure of a store's database", () => {
  it("tells a statement past a limit of its session as the caller's to narrow, not as an outage", () => {
    const error = toPostgresExecutorError({ code: "53400" }, true);

    expect(error.kind).toBe("failed");
    expect(describeDatabaseFailure(error, "The query")).toEqual({
      sentence:
        "The query went past a limit the database sets on one session, such as the room for temporary files: narrow or aggregate it (SQLSTATE 53400).",
      sqlState: "53400",
      retryable: false,
      code: "VALIDATION_FAILED"
    });
  });

  it("still tells too many connections as the server being unavailable", () => {
    expect(toPostgresExecutorError({ code: "53300" }).kind).toBe("unavailable");
  });
});
