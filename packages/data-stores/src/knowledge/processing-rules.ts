import { processingMatchers, processingSqlPattern } from "./processing-glob";
import {
  type KnowledgeDocumentFormat,
  type KnowledgeProcessingRule
} from "@work-shape/catalyst-core";
import { knowledgeProcessingOf, type knowledgeDocumentTypesSchema } from "./document-types";
import type { z } from "zod";

export function processingRules(
  types: z.infer<typeof knowledgeDocumentTypesSchema> | undefined
): KnowledgeProcessingRule[] {
  return [...(types ?? []), undefined].map((type) => {
    const processing = (format: KnowledgeDocumentFormat) =>
      knowledgeProcessingOf(type ? [{ ...type, match: { name: ["*"] } }] : undefined, {
        path: "",
        name: "file",
        mime: "",
        format
      });
    return {
      match: type
        ? Object.fromEntries(
            Object.entries(processingMatchers(type.match)).map(([field, patterns]) => [
              field,
              patterns.map(processingSqlPattern)
            ])
          )
        : {},
      keys: {
        txt: processing("txt").key,
        markdown: processing("markdown").key,
        pdf: processing("pdf").key,
        docx: processing("docx").key
      },
      processorRevision: processing("txt").processorRevision
    };
  });
}
