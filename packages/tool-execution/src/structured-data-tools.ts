import {
  STRUCTURED_DATA_RESOURCE_DISPLAY_KIND,
  currentStructuredResults,
  type PlatformStore,
  type StructuredDataFieldSource,
  type StructuredDataPublicationReviewer,
  type StructuredDataState
} from "@vivd-catalyst/core";
import {
  defineTool,
  toolFailed,
  toolSuccess,
  type AnyToolDefinition
} from "@vivd-catalyst/tool-sdk";
import {
  structuredDataPublishInputSchema,
  structuredDataPublishOutputSchema,
  structuredDataReadInputSchema,
  structuredDataReadOutputSchema,
  structuredResultReadInputSchema,
  structuredResultReadOutputSchema
} from "./structured-data-tool-schemas";

type StructuredDataToolStore = Pick<
  PlatformStore,
  | "publishStructuredDataResource"
  | "getStructuredDataResource"
  | "listStructuredDataResources"
  | "listMessages"
  | "listSentConversationAttachments"
>;

export function createStructuredDataToolDefinitions(input: {
  store: StructuredDataToolStore;
  publicationReviewer?: StructuredDataPublicationReviewer;
}): AnyToolDefinition[] {
  return [
    defineTool({
      name: "structured_data.publish",
      description:
        "Publish or update the conversation's current structured-data resource shown in the Resources panel. Use replace to supply the full structure and patch to edit named fields by stable section and field keys. Reuse the resource, section, and field keys you published earlier when updating.",
      inputSchema: structuredDataPublishInputSchema,
      outputSchema: structuredDataPublishOutputSchema,
      async execute(toolInput, context) {
        const conversationId = context.toolRequest?.conversationId;
        if (!conversationId) {
          return toolFailed(
            "handler_failed",
            "structured_data.publish requires an active tool request"
          );
        }

        const sourceFileIds = [
          ...new Set(
            toolInput.operation === "replace"
              ? toolInput.sections.flatMap((section) =>
                  section.fields.flatMap((field) =>
                    (field.sources ?? []).map((source) => source.fileId)
                  )
                )
              : (toolInput.set ?? []).flatMap((set) =>
                  (set.sources ?? []).map((source) => source.fileId)
                )
          )
        ];
        let sentAttachments:
          | Awaited<ReturnType<StructuredDataToolStore["listSentConversationAttachments"]>>
          | undefined;
        const getSentAttachments = async () => {
          sentAttachments ??= await input.store.listSentConversationAttachments({
            clientInstanceId: context.clientInstanceId,
            conversationId
          });
          return sentAttachments;
        };
        const sourceAttachmentIds = new Map<string, StructuredDataFieldSource["attachmentId"]>();
        if (sourceFileIds.length > 0) {
          for (const attachment of await getSentAttachments()) {
            sourceAttachmentIds.set(attachment.fileId, attachment.id);
          }
          const invalidSourceFileId = sourceFileIds.find(
            (fileId) => !sourceAttachmentIds.has(fileId)
          );
          if (invalidSourceFileId) {
            return toolFailed(
              "validation_failed",
              `File '${invalidSourceFileId}' is not a sent attachment of this conversation`
            );
          }
        }

        let state: StructuredDataState;
        let title: string;
        if (toolInput.operation === "replace") {
          title = toolInput.title;
          state = {
            title,
            sections: toolInput.sections.map((section) => ({
              ...section,
              fields: section.fields.map((field) => ({
                ...field,
                sources: mapSources(field.sources, sourceAttachmentIds)
              }))
            }))
          };
        } else {
          const current = (
            await input.store.listStructuredDataResources({
              clientInstanceId: context.clientInstanceId,
              conversationId
            })
          ).find((resource) => resource.resourceKey === toolInput.resourceKey);
          if (!current) {
            return toolFailed(
              "validation_failed",
              `Structured data resource '${toolInput.resourceKey}' does not exist; use operation "replace" first`
            );
          }
          title = current.title;
          state = {
            title: current.state.title,
            sections: current.state.sections.map((section) => ({
              ...section,
              fields: section.fields.map((field) => ({
                ...field,
                sources: field.sources?.map((source) => ({ ...source }))
              }))
            }))
          };
          for (const set of toolInput.set ?? []) {
            const section = state.sections.find((candidate) => candidate.key === set.sectionKey);
            if (!section) {
              return toolFailed(
                "validation_failed",
                `Structured data section '${set.sectionKey}' does not exist`
              );
            }
            const field = section.fields.find((candidate) => candidate.key === set.fieldKey);
            if (field) {
              field.value = set.value;
              if (set.label !== undefined) {
                field.label = set.label;
              }
              if (set.sources !== undefined) {
                field.sources = mapSources(set.sources, sourceAttachmentIds);
              }
              if (set.attention !== undefined) {
                if (set.attention === null) {
                  delete field.attention;
                } else {
                  field.attention = set.attention;
                }
              }
            } else {
              section.fields.push({
                key: set.fieldKey,
                label: set.label ?? set.fieldKey,
                value: set.value,
                sources: mapSources(set.sources, sourceAttachmentIds),
                ...(set.attention ? { attention: set.attention } : {})
              });
            }
          }
          for (const remove of toolInput.remove ?? []) {
            const section = state.sections.find((candidate) => candidate.key === remove.sectionKey);
            if (section) {
              section.fields = section.fields.filter((field) => field.key !== remove.fieldKey);
            }
          }
          state.sections = state.sections.filter((section) => section.fields.length > 0);
          if (state.sections.some((section) => section.fields.length > 64)) {
            return toolFailed(
              "validation_failed",
              "Structured data sections may contain at most 64 fields"
            );
          }
        }

        const warnings = input.publicationReviewer
          ? [
              ...new Set(
                (
                  await input.publicationReviewer({
                    clientInstanceId: context.clientInstanceId,
                    conversationId,
                    resourceKey: toolInput.resourceKey,
                    title,
                    state,
                    messages: await input.store.listMessages({
                      clientInstanceId: context.clientInstanceId,
                      conversationId
                    }),
                    attachments: (await getSentAttachments()).map(({ id, fileId, filename }) => ({
                      id,
                      fileId,
                      filename
                    }))
                  })
                )
                  .map((warning) => warning.trim())
                  .filter(Boolean)
              )
            ]
          : [];

        const resource = await input.store.publishStructuredDataResource({
          clientInstanceId: context.clientInstanceId,
          conversationId,
          resourceKey: toolInput.resourceKey,
          title,
          state
        });
        const fieldCount = state.sections.reduce(
          (count, section) => count + section.fields.length,
          0
        );
        const sourceRefCount = state.sections.reduce(
          (count, section) =>
            count +
            section.fields.reduce(
              (fieldCount, field) => fieldCount + (field.sources?.length ?? 0),
              0
            ),
          0
        );
        return toolSuccess(
          {
            resourceKey: resource.resourceKey,
            revision: resource.revision,
            operation: toolInput.operation,
            message:
              `Published structured data resource '${resource.resourceKey}' revision ${resource.revision}.` +
              (warnings.length > 0 ? ` Review warnings: ${warnings.join(" | ")}` : ""),
            ...(warnings.length > 0 ? { warnings } : {})
          },
          {
            display: {
              kind: STRUCTURED_DATA_RESOURCE_DISPLAY_KIND,
              version: 1,
              mode: "side_panel",
              displayId: `structured-data:${resource.id}`,
              title: resource.title,
              data: {
                structuredDataResourceId: resource.id,
                resourceKey: resource.resourceKey,
                revision: resource.revision
              }
            },
            auditSummary: {
              action: "structured_data.published",
              subject: resource.resourceKey,
              metadata: {
                operation: toolInput.operation,
                sectionCount: state.sections.length,
                fieldCount,
                sourceRefCount
              }
            }
          }
        );
      }
    }),
    defineTool({
      name: "structured_data.read",
      description:
        "Read the current structured-data resource for this conversation when the existing facts are useful. Sources are returned as model-visible file ids, filenames, and pages.",
      inputSchema: structuredDataReadInputSchema,
      outputSchema: structuredDataReadOutputSchema,
      async execute(toolInput, context) {
        const conversationId = context.toolRequest?.conversationId;
        if (!conversationId) {
          return toolFailed(
            "handler_failed",
            "structured_data.read requires an active tool request"
          );
        }
        const current = (
          await input.store.listStructuredDataResources({
            clientInstanceId: context.clientInstanceId,
            conversationId
          })
        ).find((resource) => resource.resourceKey === toolInput.resourceKey);
        if (!current) {
          return toolFailed(
            "validation_failed",
            `Structured data resource '${toolInput.resourceKey}' does not exist`
          );
        }
        const attachments = await input.store.listSentConversationAttachments({
          clientInstanceId: context.clientInstanceId,
          conversationId
        });
        const attachmentsById = new Map(
          attachments.map((attachment) => [attachment.id, attachment])
        );
        return toolSuccess({
          resourceKey: current.resourceKey,
          title: current.title,
          revision: current.revision,
          sections: current.state.sections.map((section) => ({
            key: section.key,
            label: section.label,
            fields: section.fields.map((field) => ({
              key: field.key,
              label: field.label,
              value: field.value,
              ...(field.attention ? { attention: field.attention } : {}),
              ...(field.sources
                ? {
                    sources: field.sources.flatMap((source) => {
                      const attachment = attachmentsById.get(source.attachmentId);
                      return attachment
                        ? [
                            {
                              fileId: attachment.fileId,
                              filename: attachment.filename,
                              ...(source.page !== undefined ? { page: source.page } : {})
                            }
                          ]
                        : [];
                    })
                  }
                : {})
            }))
          }))
        });
      }
    }),
    defineTool({
      name: "structured_result.read",
      description:
        "Read the current revision of a keyed structured result for this conversation. Use it when continuing or revising an existing domain result.",
      inputSchema: structuredResultReadInputSchema,
      outputSchema: structuredResultReadOutputSchema,
      async execute(toolInput, context) {
        const conversationId = context.toolRequest?.conversationId;
        if (!conversationId) {
          return toolFailed(
            "handler_failed",
            "structured_result.read requires an active tool request"
          );
        }
        const current = currentStructuredResults(
          await input.store.listMessages({
            clientInstanceId: context.clientInstanceId,
            conversationId
          })
        ).find((resource) => resource.key === toolInput.resourceKey);
        if (!current) {
          return toolFailed(
            "validation_failed",
            `Structured result '${toolInput.resourceKey}' does not exist`
          );
        }
        return toolSuccess({
          key: current.key,
          kind: current.kind,
          schemaVersion: current.schemaVersion,
          title: current.title,
          revision: current.revision,
          data: current.data
        });
      }
    })
  ];
}

function mapSources(
  sources: Array<{ fileId: string; page?: number }> | undefined,
  attachmentIds: ReadonlyMap<string, StructuredDataFieldSource["attachmentId"]>
): StructuredDataFieldSource[] | undefined {
  return sources?.map((source) => {
    const attachmentId = attachmentIds.get(source.fileId);
    if (attachmentId === undefined)
      throw new Error(`Source attachment ${source.fileId} is missing`);
    return { attachmentId, page: source.page };
  });
}
