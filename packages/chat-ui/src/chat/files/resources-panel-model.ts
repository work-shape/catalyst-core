import type {
  ConversationResourceListItem,
  LocaleCode,
  StructuredDataResourceResponse
} from "@work-shape/catalyst-api-client";
import type { ResourcesPanelPreference } from "../../shared/workspace-utils";

export const RESOURCE_SECTION_ORDER = [
  "structured_data",
  "structured_result",
  "generated_file",
  "source_file"
] as const;

export type ResourceSectionType = (typeof RESOURCE_SECTION_ORDER)[number];

export interface ResourceSection {
  type: ResourceSectionType;
  resources: ConversationResourceListItem[];
}

export function isResourcesPanelAvailable(input: {
  enabled: boolean;
  conversationId: string | undefined;
}): boolean {
  return input.enabled && Boolean(input.conversationId);
}

export function groupConversationResources(
  resources: readonly ConversationResourceListItem[]
): ResourceSection[] {
  return RESOURCE_SECTION_ORDER.flatMap((type) => {
    const grouped = resources.filter((resource) =>
      type === "structured_result"
        ? resource.resourceType === "structured_result" || resource.resourceType === "analysis"
        : resource.resourceType === type
    );
    return grouped.length > 0 ? [{ type, resources: grouped }] : [];
  });
}

export function resolveResourcesPanelOpen(input: {
  preference: ResourcesPanelPreference | undefined;
  /** Whether the card can stand beside the conversation; without a preference it opens only then. */
  roomBeside: boolean;
  hasResources: boolean;
}): boolean {
  if (!input.hasResources) {
    return false;
  }
  if (input.preference) {
    return input.preference === "open";
  }
  return input.roomBeside;
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
  return formatIsoDate(value, locale) ?? value;
}

/** A string that is exactly a valid calendar date (`YYYY-MM-DD`), in the locale's date form. */
function formatIsoDate(value: string, locale: LocaleCode): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC"
  }).format(date);
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
