import type { Catalogue, CatalogueEntryView } from "./catalogue/catalogue";
import type {
  ConnectorTypeRegistry,
  JsonObject,
  LocalizedStringConfig
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
              secret: field.secret === true
            }))
          }
        ];
      })
      .sort((left, right) => (left.type < right.type ? -1 : 1))
  };
}
