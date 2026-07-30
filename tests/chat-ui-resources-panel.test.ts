import { describe, expect, it } from "vitest";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import {
  createApiClient,
  type ConversationResourceListItem,
  type StructuredDataResourceResponse
} from "@vivd-catalyst/api-client";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  groupConversationResources,
  resolveResourcesPanelOpen,
  structuredDataToTsv
} from "../packages/chat-ui/src/resources-panel-model";
import {
  ResourcesPanel,
  SourceFilePreview
} from "../packages/chat-ui/src/resources-panel";
import { StructuredDataView } from "../packages/chat-ui/src/structured-data-view";
import { ToolDisplayPanelProvider } from "../packages/chat-ui/src/tool-display-panel";

const resources: ConversationResourceListItem[] = [
  {
    resourceId: "structured",
    resourceType: "structured_data",
    title: "Customer record",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    preview: {
      kind: "structured_data",
      structuredDataResourceId: "structured_1"
    }
  },
  {
    resourceId: "analysis-new",
    resourceType: "analysis",
    title: "New analysis",
    createdAt: "2026-07-30T11:00:00.000Z",
    updatedAt: "2026-07-30T11:00:00.000Z",
    preview: {
      kind: "typed_display",
      display: { kind: "html.rendered", data: { html: "<p>Analysis</p>" } }
    }
  },
  {
    resourceId: "analysis-old",
    resourceType: "analysis",
    title: "Old analysis",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    preview: {
      kind: "typed_display",
      display: { kind: "html.rendered", data: { html: "<p>Analysis</p>" } }
    }
  },
  {
    resourceId: "generated",
    resourceType: "generated_file",
    title: "Report.pdf",
    createdAt: "2026-07-30T09:00:00.000Z",
    updatedAt: "2026-07-30T09:00:00.000Z",
    preview: { kind: "artifact", artifactId: "artifact_1" },
    download: {
      kind: "artifact",
      artifactId: "artifact_1",
      filename: "Report.pdf"
    }
  },
  {
    resourceId: "source",
    resourceType: "source_file",
    attachmentId: "attachment_1",
    title: "Input.pdf",
    mimeType: "application/pdf",
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    preview: { kind: "source_file", fileId: "file_1" },
    download: {
      kind: "source_file",
      fileId: "file_1",
      filename: "Input.pdf"
    }
  }
];

const structuredData: StructuredDataResourceResponse = {
  id: "structured_1",
  resourceKey: "customer",
  title: "Customer record",
  revision: 1,
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  sections: [
    {
      key: "identity",
      label: "Identität",
      fields: [
        { key: "name", label: "Name", value: "Ada Lovelace" },
        { key: "revenue", label: "Umsatz", value: 1234.5 },
        { key: "active", label: "Aktiv", value: true }
      ]
    }
  ]
};

describe("Resources panel model", () => {
  it("groups in product order, hides empty sections, and preserves server order", () => {
    const grouped = groupConversationResources(
      resources.filter((resource) => resource.resourceType !== "generated_file")
    );

    expect(grouped.map((section) => section.type)).toEqual([
      "structured_data",
      "analysis",
      "source_file"
    ]);
    expect(grouped[1]?.resources.map((resource) => resource.resourceId)).toEqual([
      "analysis-new",
      "analysis-old"
    ]);
  });

  it("resolves defaults without overriding explicit preferences", () => {
    expect(
      resolveResourcesPanelOpen({
        preference: undefined,
        desktop: true,
        hasResources: true
      })
    ).toBe(true);
    expect(
      resolveResourcesPanelOpen({
        preference: undefined,
        desktop: true,
        hasResources: false
      })
    ).toBe(false);
    expect(
      resolveResourcesPanelOpen({
        preference: "closed",
        desktop: true,
        hasResources: true
      })
    ).toBe(false);
    expect(
      resolveResourcesPanelOpen({
        preference: undefined,
        desktop: false,
        hasResources: true
      })
    ).toBe(false);
  });

  it("formats copy-all text as escaped TSV", () => {
    const data: StructuredDataResourceResponse = {
      ...structuredData,
      sections: [
        {
          key: "notes",
          label: "Notes",
          fields: [
            {
              key: "detail",
              label: "Detail",
              value: "line\tone\nnext"
            },
            {
              key: "quote",
              label: "Quote",
              value: 'A "quoted" value'
            }
          ]
        }
      ]
    };

    expect(structuredDataToTsv(data, "en")).toBe(
      'Section\tField\tValue\nNotes\tDetail\t"line\tone\nnext"\nNotes\tQuote\t"A ""quoted"" value"'
    );
  });
});

describe("Resources panel rendering", () => {
  it("renders localized mixed sections and counts", () => {
    const markup = renderResourcesPanel(resources);

    expect(markup).toMatch(/Kundendaten[\s\S]*?>1</u);
    expect(markup).toMatch(/Analysen[\s\S]*?>2</u);
    expect(markup).toMatch(/Erstellte Dateien[\s\S]*?>1</u);
    expect(markup).toMatch(/Hochgeladene Dateien[\s\S]*?>1</u);
  });

  it("renders one compact empty state", () => {
    const markup = renderResourcesPanel([]);

    expect(markup).toContain("Diese Unterhaltung enthält noch keine Inhalte.");
    expect(markup).not.toContain("Kundendaten");
  });

  it("renders structured section, field labels, and formatted values", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(StructuredDataView, { resource: structuredData })
      )
    );

    expect(markup).toContain("Identität");
    expect(markup).toContain("Umsatz");
    expect(markup).toContain("1.234,5");
    expect(markup).toContain("Ja");
  });

  it("renders cookie-authenticated source images through the browser-managed URL", () => {
    const client = createApiClient({ baseUrl: "https://example.test" });
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(SourceFilePreview, {
          client,
          conversationId: "conversation/1",
          fileId: "file 1",
          filename: "Screenshot.png",
          mimeType: "image/png"
        })
      )
    );

    expect(markup).toContain(
      'src="https://example.test/api/conversations/conversation%2F1/files/file%201/content"'
    );
    expect(markup).toContain('alt="Screenshot.png"');
    expect(markup).not.toContain("Inhalte konnten nicht geladen werden.");
  });

  it("renders cookie-authenticated source PDFs inline", () => {
    const client = createApiClient({ baseUrl: "https://example.test" });
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(SourceFilePreview, {
          client,
          conversationId: "conversation/1",
          fileId: "file 1",
          filename: "Input.pdf",
          mimeType: "application/pdf"
        })
      )
    );

    expect(markup).toContain('<iframe title="Input.pdf"');
    expect(markup).toContain(
      'src="https://example.test/api/conversations/conversation%2F1/files/file%201/content"'
    );
  });
});

function renderResourcesPanel(items: ConversationResourceListItem[]): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "de" },
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ResourcesPanel, {
          client: createApiClient({ baseUrl: "https://example.test" }),
          conversationId: "conversation_1",
          loading: false,
          onClose() {},
          open: true,
          resources: items
        })
      )
    )
  );
}
