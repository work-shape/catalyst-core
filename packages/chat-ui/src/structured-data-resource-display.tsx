import { useEffect, useState, type ReactNode } from "react";
import type { StructuredDataResourceResponse } from "@vivd-catalyst/api-client";
import { STRUCTURED_DATA_RESOURCE_DISPLAY_KIND } from "@vivd-catalyst/core";
import { useAttachmentContentContext } from "./attachment-content";
import { useTranslation } from "./i18n";
import { useOpenSourceFilePreview } from "./source-file-preview";
import {
  StructuredDataCopyAllButton,
  StructuredDataView
} from "./structured-data-view";
import { Spinner } from "./ui/spinner";

export function renderStructuredDataResourceDisplay(display: {
  kind?: unknown;
  data?: unknown;
}): ReactNode {
  const structuredDataResourceId = readStructuredDataResourceId(display);
  return structuredDataResourceId ? (
    <StructuredDataResourceDisplay
      structuredDataResourceId={structuredDataResourceId}
    />
  ) : undefined;
}

function StructuredDataResourceDisplay({
  structuredDataResourceId
}: {
  structuredDataResourceId: string;
}) {
  const context = useAttachmentContentContext();
  const conversationId = context?.selectedConversationId;
  const openSourceFilePreview = useOpenSourceFilePreview();
  const { t } = useTranslation();
  const [resource, setResource] = useState<
    StructuredDataResourceResponse | undefined
  >();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!context?.selectedConversationId) {
      return undefined;
    }
    let active = true;
    setResource(undefined);
    setFailed(false);
    void context.client
      .structuredDataResource(
        context.selectedConversationId,
        structuredDataResourceId
      )
      .then((nextResource) => {
        if (active) {
          setResource(nextResource);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [
    context?.client,
    context?.selectedConversationId,
    structuredDataResourceId
  ]);

  if (failed) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("resourcesLoadFailed")}
      </div>
    );
  }
  if (!resource) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <StructuredDataCopyAllButton resource={resource} />
      </div>
      <StructuredDataView
        resource={resource}
        onSourceOpen={
          context && conversationId
            ? (source) => {
                void openSourceFilePreview({
                  client: context.client,
                  conversationId,
                  attachmentId: source.attachmentId,
                  filename: source.filename
                });
              }
            : undefined
        }
      />
    </div>
  );
}

function readStructuredDataResourceId(display: {
  kind?: unknown;
  data?: unknown;
}): string | undefined {
  if (
    display.kind !== STRUCTURED_DATA_RESOURCE_DISPLAY_KIND ||
    !isRecord(display.data) ||
    typeof display.data.structuredDataResourceId !== "string"
  ) {
    return undefined;
  }
  return display.data.structuredDataResourceId || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
