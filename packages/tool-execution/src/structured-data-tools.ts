import {
  asConversationAttachmentId,
  type PlatformStore,
  type StructuredDataFieldSource,
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
  structuredDataPublishOutputSchema
} from "./structured-data-tool-schemas";

type StructuredDataToolStore = Pick<
  PlatformStore,
  | "publishStructuredDataResource"
  | "getStructuredDataResource"
  | "listStructuredDataResources"
  | "listSentConversationAttachments"
>;

export function createStructuredDataToolDefinitions(input: {
  store: StructuredDataToolStore;
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
                sources: mapSources(field.sources)
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
            const section = state.sections.find(
              (candidate) => candidate.key === set.sectionKey
            );
            if (!section) {
              return toolFailed(
                "validation_failed",
                `Structured data section '${set.sectionKey}' does not exist`
              );
            }
            const field = section.fields.find(
              (candidate) => candidate.key === set.fieldKey
            );
            if (field) {
              field.value = set.value;
              if (set.label !== undefined) {
                field.label = set.label;
              }
              if (set.sources !== undefined) {
                field.sources = mapSources(set.sources);
              }
            } else {
              section.fields.push({
                key: set.fieldKey,
                label: set.label ?? set.fieldKey,
                value: set.value,
                sources: mapSources(set.sources)
              });
            }
          }
          for (const remove of toolInput.remove ?? []) {
            const section = state.sections.find(
              (candidate) => candidate.key === remove.sectionKey
            );
            if (section) {
              section.fields = section.fields.filter(
                (field) => field.key !== remove.fieldKey
              );
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

        const sourceIds = [
          ...new Set(
            state.sections.flatMap((section) =>
              section.fields.flatMap((field) =>
                (field.sources ?? []).map((source) => source.attachmentId)
              )
            )
          )
        ];
        if (sourceIds.length > 0) {
          const sentIds = new Set(
            (
              await input.store.listSentConversationAttachments({
                clientInstanceId: context.clientInstanceId,
                conversationId
              })
            ).map((attachment) => attachment.id)
          );
          const invalidSourceId = sourceIds.find((attachmentId) => !sentIds.has(attachmentId));
          if (invalidSourceId) {
            return toolFailed(
              "validation_failed",
              `Attachment '${invalidSourceId}' is not a sent attachment of this conversation`
            );
          }
        }

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
            message: `Published structured data resource '${resource.resourceKey}' revision ${resource.revision}.`
          },
          {
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
    })
  ];
}

function mapSources(
  sources: Array<{ attachmentId: string; page?: number }> | undefined
): StructuredDataFieldSource[] | undefined {
  return sources?.map((source) => ({
    attachmentId: asConversationAttachmentId(source.attachmentId),
    page: source.page
  }));
}
