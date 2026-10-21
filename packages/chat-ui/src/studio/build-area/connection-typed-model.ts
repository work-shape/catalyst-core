import type { ConnectorTypeOffers, LocaleCode } from "@work-shape/catalyst-api-client";
import { recordOf } from "./connection-approval-model";

// A Connector type the build offers with its own form, such as a document source: the New
// connection dialog shows a card for it and asks for the fields the type declares.

/** One type the New connection dialog offers beside an MCP server and a REST API. */
export type ConnectorTypeOffer = ConnectorTypeOffers["types"][number];

/** A text of the type in the reader's language: the reader's, else English, else German. */
export type OfferText = ConnectorTypeOffer["title"];

export function offerText(text: OfferText | undefined, locale: LocaleCode): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text.en ?? text.de ?? "";
}

/** The values typed into the form, by the field's position. */
export type TypedValues = Readonly<Record<number, string>>;

/** Every field that is not optional holds a value. */
export function typedComplete(offer: ConnectorTypeOffer, values: TypedValues): boolean {
  return offer.fields.every(
    (field, index) => field.optional || (values[index] ?? "").trim() !== ""
  );
}

/** The secret typed into the form, or nothing where the type asks for none. */
export function typedSecret(offer: ConnectorTypeOffer, values: TypedValues): string {
  const index = offer.fields.findIndex((field) => field.secret);
  return index === -1 ? "" : (values[index] ?? "");
}

/**
 * The definition of a new Connection of the type: its fixed settings with each typed value at
 * the dotted path its field names. An optional field left empty is left out. No operation is
 * accepted: the type's tools, where it has any, are approved on the Connection's page.
 */
export function typedConnectionConfig(
  offer: ConnectorTypeOffer,
  start: { name: string; title: string; description: string },
  values: TypedValues
): Record<string, unknown> {
  const settings: Record<string, unknown> = structuredClone(offer.settings);
  offer.fields.forEach((field, index) => {
    const value = (values[index] ?? "").trim();
    if (field.setting === undefined || value === "") return;
    setAt(settings, field.setting.split("."), value);
  });
  const description = start.description.trim();
  return {
    name: start.name,
    displayName: start.title,
    ...(description === "" ? {} : { description }),
    connectorType: offer.type,
    authScheme: offer.authScheme,
    settings,
    operations: [],
    enabled: true
  };
}

function setAt(target: Record<string, unknown>, path: readonly string[], value: string): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child: Record<string, unknown> = { ...recordOf(target[head]) };
  setAt(child, rest, value);
  target[head] = child;
}
