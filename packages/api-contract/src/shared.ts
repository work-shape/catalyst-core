import { z } from "zod";

/** ISO 8601 timestamps always denote UTC, never a local offset. */
export const timestampSchema = z.iso.datetime({ offset: false });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional()
});

export function listEnvelopeSchema<Schema extends z.ZodType>(item: Schema) {
  return z.object({ items: z.array(item), nextCursor: z.string().optional() });
}
