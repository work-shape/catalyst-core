import type { Catalogue, CatalogueEntryView } from "./catalogue/catalogue";
import {
  connectorTypeExposures,
  type ConnectionExposure,
  type ConnectionOperationEffect,
  type ConnectorFormFieldValue,
  type ConnectorTypeRegistry,
  type JsonObject,
  type LocalizedStringConfig
} from "@work-shape/catalyst-core";

/** One field of a type's form as the New connection dialog reads it. */
export interface ConnectorFormFieldView {
  label: LocalizedStringConfig;
  help?: LocalizedStringConfig;
  optional: boolean;
  /** The dotted path in `settings` the value goes to; absent for the secret. */
  setting?: string;
  secret: boolean;
  /** What a setting holds: text, a whole number or a list. Text where left out. */
  value?: ConnectorFormFieldValue;
  /** What the field starts with. Never for the secret. */
  default?: string;
  /** The field folds away under "Technical details". */
  advanced?: true;
}

/** An operation of the type's own catalog, as the approval step after Verbinden lists it. */
export interface ConnectorTypeOfferOperation {
  name: string;
  description: string;
  effect: ConnectionOperationEffect;
}

/** A Connector type the New connection dialog offers, with its card and its form. */
export interface ConnectorTypeOfferView {
  type: string;
  title: LocalizedStringConfig;
  description: LocalizedStringConfig;
  service?: string;
  /** A Knowledge Base can sync documents through a Connection of the type. */
  documentSource: boolean;
  authScheme: string;
  settings: JsonObject;
  fields: ConnectorFormFieldView[];
  /** Whose account everyone reads, before the secret and where the setup asks who may use it. */
  sharedAccountNote?: LocalizedStringConfig;
  /**
   * The operations of the type's static catalog, which the setup offers to approve once it
   * connected. Empty for a type without one, such as a document source.
   */
  operations: ConnectorTypeOfferOperation[];
  /** Where an approved operation may be used: only by agents for a `privateResults` type. */
  exposures: ConnectionExposure[];
}

/** An entry as the dialog reads it: an OAuth part also names the redirect URI to register. */
export type CatalogueEntryOfferView = Omit<CatalogueEntryView, "parts"> & {
  parts: (CatalogueEntryView["parts"][number] & { redirectUri?: string })[];
};

/**
 * The types of the build that declare a form, by type id, and the catalogue's entries. A type
 * without a form, such as `mcp` and `http_api` with their own dialog, is not listed. The
 * dialog shows an entry's card in place of the card of a type the entry names. An OAuth part
 * names the instance's redirect URI for its fixed name, so its checklist shows the exact value
 * the sign-in will send; nothing where the instance has no public address.
 */
export function connectorTypeOffers(
  registry: ConnectorTypeRegistry,
  catalogue?: Pick<Catalogue, "entries">,
  redirectUri?: (connectionName: string) => string | undefined
): {
  types: ConnectorTypeOfferView[];
  entries: CatalogueEntryOfferView[];
} {
  return {
    entries: (catalogue?.entries ?? []).map((entry) => ({
      ...entry,
      parts: entry.parts.map((part) => {
        const redirect = redirectUri?.(part.name);
        // A checklist line valued `{redirectUri}` shows the address the sign-in will send.
        const prerequisites = part.prerequisites.map((line) =>
          line.value !== "{redirectUri}"
            ? line
            : { text: line.text, ...(redirect === undefined ? {} : { value: redirect }) }
        );
        return {
          ...part,
          prerequisites,
          ...(part.authScheme === "oauth" && redirect !== undefined
            ? { redirectUri: redirect }
            : {})
        };
      })
    })),
    types: registry.types
      .flatMap((definition) => {
        const { form } = definition;
        if (form === undefined) return [];
        return [
          {
            type: definition.type,
            title: form.title,
            description: form.description,
            ...(form.service === undefined ? {} : { service: form.service }),
            documentSource: definition.documentSource !== undefined,
            authScheme: form.authScheme,
            settings: form.settings ?? {},
            fields: form.fields.map((field) => ({
              label: field.label,
              ...(field.help === undefined ? {} : { help: field.help }),
              optional: field.optional === true,
              ...(field.setting === undefined ? {} : { setting: field.setting }),
              secret: field.secret === true,
              ...(field.value === undefined ? {} : { value: field.value }),
              ...(field.default === undefined ? {} : { default: field.default }),
              ...(field.advanced ? { advanced: true as const } : {})
            })),
            ...(form.sharedAccountNote === undefined
              ? {}
              : { sharedAccountNote: form.sharedAccountNote }),
            operations: (definition.catalog ?? []).map((operation) => ({
              name: operation.name,
              description: operation.description,
              effect: operation.proposedEffect
            })),
            exposures: [...connectorTypeExposures(definition)]
          }
        ];
      })
      .sort((left, right) => (left.type < right.type ? -1 : 1))
  };
}
