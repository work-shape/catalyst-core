import { z } from "zod";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const written = z.object({ inserted: z.number(), updated: z.number() });

/** The persistent app-privilege frame keeps provenance and projection in one transaction. */
export function recordProjection(sql: PostgresChangeStatements) {
  return {
    async write(statement: string | null, rows: string) {
      return written.parse(
        (
          await sql.run("select * from catalyst.project_record($1::text,$2::jsonb)", [
            statement,
            rows
          ])
        )[0]
      );
    }
  };
}
