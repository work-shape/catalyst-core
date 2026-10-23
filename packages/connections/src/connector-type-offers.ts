import type { Catalogue, CatalogueEntryView } from "./catalogue/catalogue";
import {
  connectionOAuthCallbackPath,
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
}

/**
 * The types of the build that declare a form, by type id, and the catalogue's entries. A type
 * without a form, such as `mcp` and `http_api` with their own dialog, is not listed. The
 * dialog shows an entry's card in place of the card of a type the entry names.
 */
export function connectorTypeOffers(
  registry: ConnectorTypeRegistry,
  catalogue?: Pick<Catalogue, "entries">,
  publicUrl?: string
): {
  types: ConnectorTypeOfferView[];
  entries: CatalogueEntryView[];
} {
  return {
    entries: (catalogue?.entries ?? []).map((entry) => ({
      ...entry,
      parts: entry.parts.map((part) => ({
        ...part,
        prerequisites: part.prerequisites.map((line) =>
          line.value !== "{redirectUri}"
            ? line
            : {
                text: line.text,
                ...(publicUrl === undefined
                  ? {}
                  : { value: new URL(connectionOAuthCallbackPath(part.name), publicUrl).href })
              }
        )
      }))
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
              secret: field.secret === true
            }))
          }
        ];
      })
      .sort((left, right) => (left.type < right.type ? -1 : 1))
  };
}
