import type { ChatMessage } from "./conversation";
import type { JsonObject } from "./json";
import { readToolResultMetadata } from "./message-metadata";

export type StructuredResultPublication = {
  key: string;
  kind: string;
  schemaVersion: number;
  title: string;
  data: JsonObject;
};

export type CurrentStructuredResult = StructuredResultPublication & {
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export function readStructuredResultPublication(
  result: unknown
): StructuredResultPublication | undefined {
  if (!isObject(result) || result.status !== "success") {
    return undefined;
  }
  const publication = parsePublication(result.structuredResult);
  if (publication) {
    return publication;
  }

  const display = isObject(result.display) ? result.display : undefined;
  const resource = display && isObject(display.resource) ? display.resource : undefined;
  if (
    resource?.category !== "analysis" ||
    typeof resource.key !== "string" ||
    resource.key.length === 0 ||
    typeof display?.kind !== "string" ||
    display.kind.length === 0 ||
    typeof display.version !== "number" ||
    !Number.isInteger(display.version) ||
    display.version < 1
  ) {
    return undefined;
  }
  return {
    key: resource.key,
    kind: display.kind,
    schemaVersion: display.version,
    title:
      typeof display.title === "string" && display.title.length > 0 ? display.title : resource.key,
    data: isObject(display.data) ? display.data : {}
  };
}

export function currentStructuredResults(
  messages: readonly ChatMessage[]
): CurrentStructuredResult[] {
  const current = new Map<string, CurrentStructuredResult & { firstPublishedAt: string }>();
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const publication = readStructuredResultPublication(
      readToolResultMetadata(message.metadata)?.result
    );
    if (!publication) {
      continue;
    }
    const existing = current.get(publication.key);
    if (existing && existing.kind !== publication.kind) {
      continue;
    }
    const firstPublishedAt = existing?.firstPublishedAt ?? message.createdAt;
    current.set(publication.key, {
      ...publication,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: firstPublishedAt,
      updatedAt: message.createdAt,
      firstPublishedAt
    });
  }
  return [...current.values()]
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key)
    )
    .map(({ firstPublishedAt: _firstPublishedAt, ...result }) => result);
}

function parsePublication(value: unknown): StructuredResultPublication | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    typeof value.schemaVersion !== "number" ||
    !Number.isInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    !isObject(value.data)
  ) {
    return undefined;
  }
  return {
    key: value.key,
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    title: value.title,
    data: value.data
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
