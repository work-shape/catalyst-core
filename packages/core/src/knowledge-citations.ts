import { z } from "zod";

/** A cited passage's identity, never its text; kept with the answer under chat retention. */
export interface KnowledgeCitationSource {
  ref: string;
  knowledgeBase: string;
  documentId: string;
  fileId: string;
  fileName: string;
  page?: number;
  /** The name of the sheet, in a spreadsheet, where `page` counts sheets. */
  sheet?: string;
  originLink?: string;
  /** The document's date at its source, which the citation shows ("Stand 01.11.2026"). */
  modifiedAt?: string;
}

const sourceSchema = z.object({
  ref: z.string().regex(/^K[1-9][0-9]*$/),
  knowledgeBase: z.string().min(1),
  documentId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  page: z.number().int().positive().optional(),
  sheet: z.string().min(1).optional(),
  heading: z.string().min(1).optional(),
  originLink: z.string().optional(),
  modifiedAt: z.iso.datetime({ offset: true }).optional().catch(undefined)
});

/** Reads persisted identities or search passages, discarding passage text and extra fields. */
export function readKnowledgeCitationSources(value: unknown): KnowledgeCitationSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = sourceSchema.safeParse(entry);
    if (!parsed.success) return [];
    // A heading is passage text and stays behind, but for a spreadsheet's passage it names the
    // sheet, which the citation shows.
    const { heading, ...source } = parsed.data;
    return [
      heading && /\.xlsx$/iu.test(source.fileName)
        ? { ...source, sheet: source.sheet ?? heading }
        : source
    ];
  });
}
