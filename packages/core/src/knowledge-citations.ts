import { z } from "zod";

/** A cited passage's identity, never its text; kept with the answer under chat retention. */
export interface KnowledgeCitationSource {
  ref: string;
  knowledgeBase: string;
  documentId: string;
  fileId: string;
  fileName: string;
  page?: number;
  originLink?: string;
}

const sourceSchema = z.object({
  ref: z.string().regex(/^K[1-9][0-9]*$/),
  knowledgeBase: z.string().min(1),
  documentId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  page: z.number().int().positive().optional(),
  originLink: z.string().optional()
});

/** Reads persisted identities or search passages, discarding passage text and extra fields. */
export function readKnowledgeCitationSources(value: unknown): KnowledgeCitationSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = sourceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
