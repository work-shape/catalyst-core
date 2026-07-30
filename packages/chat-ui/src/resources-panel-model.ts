import type {
  ConversationResourceListItem,
  LocaleCode,
  StructuredDataResourceResponse
} from "@vivd-catalyst/api-client";
import type { ResourcesPanelPreference } from "./workspace-utils";

export const RESOURCE_SECTION_ORDER = [
  "structured_data",
  "analysis",
  "generated_file",
  "source_file"
] as const;

export type ResourceSectionType = (typeof RESOURCE_SECTION_ORDER)[number];

export interface ResourceSection {
  type: ResourceSectionType;
  resources: ConversationResourceListItem[];
}

export function groupConversationResources(
  resources: readonly ConversationResourceListItem[]
): ResourceSection[] {
  return RESOURCE_SECTION_ORDER.flatMap((type) => {
    const grouped = resources.filter((resource) => resource.resourceType === type);
    return grouped.length > 0 ? [{ type, resources: grouped }] : [];
  });
}

export function resolveResourcesPanelOpen(input: {
  preference: ResourcesPanelPreference | undefined;
  desktop: boolean;
  hasResources: boolean;
}): boolean {
  if (input.preference) {
    return input.preference === "open";
  }
  return input.desktop && input.hasResources;
}

export function formatStructuredDataValue(
  value: string | number | boolean | null,
  locale: LocaleCode
): string {
  if (value === null) {
    return "—";
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat(locale).format(value);
  }
  if (typeof value === "boolean") {
    return locale === "de" ? (value ? "Ja" : "Nein") : value ? "Yes" : "No";
  }
  return value;
}

export function structuredDataToTsv(
  resource: StructuredDataResourceResponse,
  locale: LocaleCode
): string {
  const rows = [
    ["Section", "Field", "Value"],
    ...resource.sections.flatMap((section) =>
      section.fields.map((field) => [
        section.label,
        field.label,
        formatStructuredDataValue(field.value, locale)
      ])
    )
  ];
  return rows.map((row) => row.map(escapeTsvCell).join("\t")).join("\n");
}

function escapeTsvCell(value: string): string {
  return /[\t\n\r"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
