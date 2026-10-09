import { sql, type SQLWrapper } from "drizzle-orm";
import { AppError, type StorePage } from "@vivd-catalyst/core";

export function keysetFilter(
  page: StorePage | undefined,
  columns: readonly SQLWrapper[],
  descending: boolean
) {
  if (!page?.after) return undefined;
  if (page.after.length !== columns.length)
    throw new AppError("VALIDATION_FAILED", "List cursor is invalid");
  const left = sql.join(
    columns.map((column) => sql`${column}`),
    sql`, `
  );
  const right = sql.join(
    page.after.map((value) => sql`${value}`),
    sql`, `
  );
  return descending ? sql`(${left}) < (${right})` : sql`(${left}) > (${right})`;
}
