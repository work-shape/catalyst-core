import { AppError, type StorePage } from "@vivd-catalyst/core";
import { listQuerySchema, timestampSchema } from "@vivd-catalyst/api-contract";
import { z } from "zod";

const rowSchema = z.record(z.string(), z.unknown());
const keySchema = z.union([z.string(), z.number()]);
const cursorSchema = z.object({ scope: z.string(), keys: z.array(keySchema).min(1) });

type Key = z.infer<typeof keySchema>;

function readCursor(
  cursor: string | undefined,
  scope: string,
  order: readonly string[]
): Key[] | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    if (parsed.scope !== scope) throw new Error("Wrong list");
    if (parsed.keys.length !== order.length) throw new Error("Wrong key count");
    for (const [index, field] of order.entries()) {
      const schema =
        field.endsWith("At") || field === "at"
          ? timestampSchema
          : field === "revision"
            ? z.number().int().positive()
            : z.string();
      const key = parsed.keys[index];
      if (!schema.safeParse(key).success) throw new Error("Wrong key type");
      // No store holds a NUL byte, so no row a list answered carries one in its key.
      if (typeof key === "string" && key.includes("\u0000")) throw new Error("Wrong key");
    }
    return parsed.keys;
  } catch {
    throw new AppError("VALIDATION_FAILED", "List cursor is invalid");
  }
}

export function pageScope(operationId: string, params: unknown, query: unknown): string {
  const filters = rowSchema.parse(query);
  const { limit: _limit, cursor: _cursor, ...rest } = filters;
  return JSON.stringify([operationId, params, rest]);
}

/** Stable tuple ordering; ties always include a unique resource key. */
export function paginate<Row>(
  rows: readonly Row[],
  query: unknown,
  order: readonly string[],
  descending: boolean,
  scope: string
): { items: Row[]; nextCursor?: string } {
  const { limit, cursor } = listQuerySchema.parse(query);
  const after = readCursor(cursor, scope, order);
  const keys = (row: Row) => {
    const record = rowSchema.parse(row);
    return order.map((field) => {
      let value: unknown = record;
      for (const segment of field.split(".")) value = rowSchema.parse(value)[segment];
      return keySchema.parse(value);
    });
  };
  if (after && after.length !== order.length) {
    throw new AppError("VALIDATION_FAILED", "List cursor is invalid");
  }
  const compare = (left: Key[], right: Key[]) => {
    for (let index = 0; index < left.length; index++) {
      const a = left[index];
      const b = right[index];
      if (a === undefined || b === undefined) throw new AppError("INTERNAL", "Invalid paging key");
      if (a !== b) {
        const compared =
          typeof a === "string" && typeof b === "string"
            ? Buffer.compare(Buffer.from(a), Buffer.from(b))
            : a < b
              ? -1
              : 1;
        return compared * (descending ? -1 : 1);
      }
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => compare(keys(a), keys(b)));
  const eligible = after ? sorted.filter((row) => compare(keys(row), after) > 0) : sorted;
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    ...(eligible.length > limit && last
      ? {
          nextCursor: Buffer.from(JSON.stringify({ scope, keys: keys(last) })).toString("base64url")
        }
      : {})
  };
}

export function storePage(query: unknown, order: readonly string[], scope: string): StorePage {
  const { limit, cursor } = listQuerySchema.parse(query);
  const after = readCursor(cursor, scope, order);
  return { limit: limit + 1, ...(after ? { after } : {}) };
}
