import type { ConnectorTypeOffers } from "@work-shape/catalyst-api-client";
import {
  declaredCandidate,
  operationTitle,
  readingNames,
  recordOf,
  type ApprovalCandidate
} from "./connection-approval-model";
import type { ConnectorTypeOffer, TypedValues } from "./connection-typed-model";

// The catalogue's entries (CAT-1): one card per entry in "Dienste" on the Connections page,
// and the part an admin installs through the form of its type. Pure: the dialog holds the
// choice.
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

/**
 * The settings of a part's Connection on the operator's managed OAuth client (MS-APP-1): the
 * part's fixed settings with the client named and no client id of its own.
 */
export function managedSettings(
  settings: Record<string, unknown>,
  managedClient: string
): Record<string, unknown> {
  const copy = structuredClone(settings);
  const { clientId: _clientId, ...oauth } = recordOf(copy.oauth) ?? {};
  return { ...copy, oauth: { ...oauth, managedClient } };
}

/** The setting of the client id a part's form asks for. */
const CLIENT_ID_SETTING = "oauth.clientId";

/**
 * Where what the form's secret field takes goes: the instance's OAuth app, where the part can
 * use one and the installer may set it, or the Connection's own secret.
 */
export function partSecretTarget(part: CataloguePartOffer): "oauth_app" | "connection" {
  return part.oauthApp?.mayEnter === true && part.oauthApp.clientId === undefined
    ? "oauth_app"
    : "connection";
}

/**
 * The part as a form of its type: the entry's title and service, the part's fields. On the
 * operator's managed client (`managed`, where the instance has one for the part) it asks for
 * no field: the client id, the secret and the tenant come from the operator. On the instance's
 * OAuth app it asks for neither client id nor secret: the app's client id is written.
 */
export function partOffer(
  entry: CatalogueEntryOffer,
  part: CataloguePartOffer,
  managed = false
): ConnectorTypeOffer {
  // The instance's OAuth app of the part's server (OAUTH-APP), where it has one.
  const appClientId = part.oauthApp?.clientId;
  if (managed && part.managedClient !== undefined) {
    return {
      type: part.connectorType,
      title: entry.title,
      description: part.description,
      service: entry.service,
      documentSource: part.documentSource,
      authScheme: part.authScheme,
      settings: managedSettings(part.settings, part.managedClient),
      fields: [],
      ...PART_REVIEWS_ITS_OWN
    };
  }
  return {
    type: part.connectorType,
    title: entry.title,
    description: part.description,
    service: entry.service,
    documentSource: part.documentSource,
    authScheme: part.authScheme,
    settings: appClientId === undefined ? part.settings : appSettings(part.settings, appClientId),
    fields: partFields(part).map((field) => ({
      label: field.label,
      ...(field.help === undefined ? {} : { help: field.help }),
      optional: field.optional,
      ...(field.setting === undefined ? {} : { setting: field.setting }),
      secret: field.secret
    })),
    ...PART_REVIEWS_ITS_OWN
  };
}

/**
 * The fields the part's form asks for: on the instance's OAuth app neither client id nor
 * secret, which the app holds.
 */
function partFields(part: CataloguePartOffer): CataloguePartOffer["fields"] {
  return part.oauthApp?.clientId === undefined
    ? part.fields
    : part.fields.filter((field) => !(field.secret || field.setting === CLIENT_ID_SETTING));
}

/** The part's settings with the client id of the instance's OAuth app. */
function appSettings(settings: Record<string, unknown>, clientId: string): Record<string, unknown> {
  const copy = structuredClone(settings);
  return { ...copy, oauth: { ...recordOf(copy.oauth), clientId } };
}

/**
 * A part's operations are the entry's, reviewed by the install after Verbinden: the form
 * offers none of its own, and where they may be used is the review's to say.
 */
const PART_REVIEWS_ITS_OWN = {
  operations: [],
  exposures: ["agent", "bridge", "workflow", "outside"]
} satisfies Pick<ConnectorTypeOffer, "operations" | "exposures">;

/** What the fields start with: each field's default, by its position. Never a secret. */
export function partDefaults(part: CataloguePartOffer): TypedValues {
  return Object.fromEntries(
    partFields(part).flatMap((field, index) =>
      field.default === undefined || field.secret ? [] : [[index, field.default] as const]
    )
  );
}

/**
 * The form of the part a Connection was installed from (`config.catalogue`), as its page shows
 * and edits it: the entry's fields, not an address and a key. Nothing where the instance no
 * longer lists the entry or the part, or where the part made another type.
 */
export function installedPartOffer(
  config: Record<string, unknown>,
  entries: readonly CatalogueEntryOffer[]
): ConnectorTypeOffer | undefined {
  const link = recordOf(config.catalogue);
  const entry = entries.find((candidate) => candidate.id === link?.entry);
  const part = entry?.parts.find(
    (candidate) => candidate.part === link?.part && candidate.connectorType === config.connectorType
  );
  if (entry === undefined || part === undefined) return undefined;
  const managed = recordOf(recordOf(config.settings)?.oauth)?.managedClient !== undefined;
  return partOffer(entry, part, managed);
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
 * reading operation the entry recommends starts ticked; one it does not starts unticked. A
 * changing one starts unticked too, except in a part that is personal alone, where each
 * person's own rights at the service are the bound and the entry may tick it.
 */
export function partCandidates(part: CataloguePartOffer): ApprovalCandidate[] {
  return part.operations.map((operation): ApprovalCandidate => {
    const declaration = operation.declaration ?? {};
    const recommended = tickedInAdvance(part, operation);
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

/** Whether a part is personal alone: each person's own rights at the service are the bound. */
function personalAlone(part: Pick<CataloguePartOffer, "credentialModes">): boolean {
  return (
    part.credentialModes !== undefined &&
    part.credentialModes.length > 0 &&
    part.credentialModes.every((mode) => mode === "user")
  );
}

/**
 * Whether the review step ticks an operation in advance: a reading one the entry recommends,
 * and a changing one it recommends only in a part that is personal alone.
 */
export function tickedInAdvance(
  part: Pick<CataloguePartOffer, "credentialModes">,
  operation: Pick<CataloguePartOffer["operations"][number], "recommended" | "effect">
): boolean {
  return operation.recommended && (operation.effect === "reading" || personalAlone(part));
}

/** The operations the review step starts with ticked. */
export function recommendedNames(part: CataloguePartOffer): string[] {
  const candidates = partCandidates(part);
  const reading = new Set(readingNames(candidates));
  return candidates
    .filter(
      (candidate) =>
        reading.has(candidate.name) ||
        (candidate.effect === "changing" && candidate.recommended === true)
    )
    .map((candidate) => candidate.name);
}
