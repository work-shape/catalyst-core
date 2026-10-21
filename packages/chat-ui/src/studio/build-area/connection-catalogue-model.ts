import type { ConnectorTypeOffers } from "@work-shape/catalyst-api-client";
import {
  declaredCandidate,
  operationTitle,
  readingNames,
  type ApprovalCandidate
} from "./connection-approval-model";
import type { ConnectorTypeOffer, TypedValues } from "./connection-typed-model";

// The catalogue's entries in New connection (CAT-1): one card per entry in "Dienste", and the
// part an admin installs through the form of its type. Pure: the dialog holds the choice.
// An entry only recommends. Its install writes a Connection with no operation; the review
// step ticks the reading operations it recommends, and only the admin's confirmation enables
// any. Nothing here grants a right.

export type CatalogueEntryOffer = ConnectorTypeOffers["entries"][number];
export type CataloguePartOffer = CatalogueEntryOffer["parts"][number];
export type CataloguePartName = CataloguePartOffer["part"];

/**
 * The Connector types an offered entry's card stands in for: their own cards are not shown.
 * A type whose entry the operator has not named keeps its own card.
 */
export function typesWithEntries(entries: readonly CatalogueEntryOffer[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.offered)
      .flatMap((entry) => entry.parts.map((part) => part.connectorType))
  );
}

/** The entries with a part to install, offered ones first, each group in the release's order. */
export function entriesToShow(entries: readonly CatalogueEntryOffer[]): CatalogueEntryOffer[] {
  const shown = entries.filter((entry) => entry.parts.length > 0);
  return [...shown.filter((entry) => entry.offered), ...shown.filter((entry) => !entry.offered)];
}

/** The part as a form of its type: the entry's title and service, the part's fields. */
export function partOffer(
  entry: CatalogueEntryOffer,
  part: CataloguePartOffer
): ConnectorTypeOffer {
  return {
    type: part.connectorType,
    title: entry.title,
    description: part.description,
    service: entry.service,
    documentSource: part.documentSource,
    authScheme: part.authScheme,
    settings: part.settings,
    fields: part.fields.map((field) => ({
      label: field.label,
      ...(field.help === undefined ? {} : { help: field.help }),
      optional: field.optional,
      ...(field.setting === undefined ? {} : { setting: field.setting }),
      secret: field.secret
    }))
  };
}

/** What the fields start with: each field's default, by its position. Never a secret. */
export function partDefaults(part: CataloguePartOffer): TypedValues {
  return Object.fromEntries(
    part.fields.flatMap((field, index) =>
      field.default === undefined || field.secret ? [] : [[index, field.default] as const]
    )
  );
}

/** The link the Connection keeps to the entry it was installed from. */
export function catalogueLink(
  entry: Pick<CatalogueEntryOffer, "id" | "version">,
  part: CataloguePartName
): { entry: string; part: CataloguePartName; version: number } {
  return { entry: entry.id, part, version: entry.version };
}

/**
 * The rows of the review step: each operation the part proposes, with the entry's effect. A
 * reading operation the entry recommends starts ticked; one it does not, and every changing
 * one, starts unticked.
 */
export function partCandidates(part: CataloguePartOffer): ApprovalCandidate[] {
  return part.operations.map((operation): ApprovalCandidate => {
    const declaration = operation.declaration ?? {};
    const recommended = operation.recommended && operation.effect === "reading";
    if (typeof declaration.path === "string") {
      return {
        ...declaredCandidate({ ...declaration, effect: operation.effect }, operation.name),
        recommended
      };
    }
    // An operation of a type with a catalog of its own: only a tighter policy is declared.
    const policy = declaration.policy;
    return {
      name: operation.name,
      title: operation.title ?? operationTitle(operation.name),
      ...(operation.description === undefined ? {} : { description: operation.description }),
      effect: operation.effect,
      ...(policy === "deny" || policy === "approval" ? { declaration: { policy } } : {}),
      recommended
    };
  });
}

/** The operations the review step starts with ticked. */
export function recommendedNames(part: CataloguePartOffer): string[] {
  return readingNames(partCandidates(part));
}
