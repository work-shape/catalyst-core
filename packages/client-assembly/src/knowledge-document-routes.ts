import { apiOperations } from "@work-shape/catalyst-api-contract";
import { type KnowledgeFiles } from "@work-shape/catalyst-core";
import type { KnowledgeBases } from "@work-shape/catalyst-data-stores";
import type { RouteRegistration } from "@work-shape/catalyst-server";

export function knowledgeDocumentRoutes(input: {
  knowledgeBases: KnowledgeBases;
  files: KnowledgeFiles | undefined;
}): RouteRegistration {
  return (routes) =>
    routes.operation(apiOperations["knowledge_bases.open_document"], {
      module: "knowledge",
      // The named right resolves this resource to its stored identity and workspace before
      // authorization and policy, just as other asset reads do.
      resource: ({ knowledgeBase }) => ({
        kind: "knowledge_base",
        id: knowledgeBase,
        name: knowledgeBase
      }),
      execute: ({ knowledgeBase, documentId }, context) =>
        input.knowledgeBases.openDocument(
          input.files,
          knowledgeBase,
          documentId,
          context.runtime.signal
        )
    });
}
