import type { ConnectorTypeOffers, LocaleCode } from "@work-shape/catalyst-api-client";
import {
  APPROVAL_SURFACES,
  operationTitle,
  recordOf,
  type ApprovalCandidate,
  type ApprovalSurface
} from "./connection-approval-model";

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

/** One field of a type's form. */
export type TypedField = ConnectorTypeOffer["fields"][number];

/** A value a proposal names for a setting: text, a number or a list. */
export type TypedSettingValue = string | number | readonly string[];

/**
 * What the fields start with: the value a proposal named for the field's setting, else the
 * field's own default. Never the secret.
 */
export function typedInitialValues(
  offer: ConnectorTypeOffer,
  proposed: Readonly<Record<string, TypedSettingValue>> = {}
): TypedValues {
  const values: Record<number, string> = {};
  offer.fields.forEach((field, index) => {
    if (field.secret || field.setting === undefined) return;
    const named = proposed[field.setting];
    const text =
      named === undefined
        ? field.default
        : typeof named === "string"
          ? named
          : typeof named === "number"
            ? String(named)
            : named.join(", ");
    if (text !== undefined) values[index] = text;
  });
  return values;
}

/**
 * A typed value as its setting holds it: a whole number for a number field, the names of a
 * list split at commas and line breaks. A number that does not read as one stays text, so the
 * type's settings refuse it with their own reason.
 */
export function typedSettingValue(field: TypedField, value: string): unknown {
  switch (field.value) {
    case "number":
      return /^\d+$/u.test(value) ? Number(value) : value;
    case "list":
      return value
        .split(/[,\n]/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    default:
      return value;
  }
}

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
    setAt(settings, field.setting.split("."), typedSettingValue(field, value));
  });
  const description = start.description.trim();
  return {
    name: start.name,
    displayName: start.title,
    ...(description === "" ? {} : { description }),
    // The slug picks the mark a list shows; it is checked as every `service` is.
    ...(offer.service === undefined ? {} : { service: offer.service }),
    connectorType: offer.type,
    authScheme: offer.authScheme,
    settings,
    operations: [],
    enabled: true
  };
}

/**
 * What a Connection's fields hold now, read from its settings at each field's dotted path, for
 * its page to edit. Never the secret, and never a default the definition does not hold.
 */
export function typedStoredValues(
  offer: ConnectorTypeOffer,
  config: Record<string, unknown>
): TypedValues {
  const settings = recordOf(config.settings) ?? {};
  const values: Record<number, string> = {};
  offer.fields.forEach((field, index) => {
    if (field.secret || field.setting === undefined) return;
    const value = field.setting
      .split(".")
      .reduce<unknown>((at, key) => recordOf(at)?.[key], settings);
    if (typeof value === "string") values[index] = value;
    else if (typeof value === "number") values[index] = String(value);
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
      values[index] = value.join(", ");
  });
  return values;
}

/** Every field that is not optional holds a value; the secret is written on its own. */
export function typedSettingsComplete(offer: ConnectorTypeOffer, values: TypedValues): boolean {
  return offer.fields.every(
    (field, index) => field.secret || field.optional || (values[index] ?? "").trim() !== ""
  );
}

/**
 * The definition with each field's value at its setting, as the page edits it: an optional
 * field left empty is taken out. Every other setting stays as it is, and the secret is not here.
 */
export function withTypedSettings(
  config: Record<string, unknown>,
  offer: ConnectorTypeOffer,
  values: TypedValues
): Record<string, unknown> {
  const settings: Record<string, unknown> = structuredClone(recordOf(config.settings) ?? {});
  offer.fields.forEach((field, index) => {
    if (field.secret || field.setting === undefined) return;
    const value = (values[index] ?? "").trim();
    const path = field.setting.split(".");
    if (value === "") removeAt(settings, path);
    else setAt(settings, path, typedSettingValue(field, value));
  });
  return { ...config, settings };
}

function removeAt(target: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    delete target[head];
    return;
  }
  const child = recordOf(target[head]);
  if (child === undefined) return;
  const copy = { ...child };
  removeAt(copy, rest);
  target[head] = copy;
}

function setAt(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
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

/** The type's operations as rows of the approval list: the reading ones start ticked. */
export function typedCandidates(offer: ConnectorTypeOffer): ApprovalCandidate[] {
  return offer.operations.map((operation) => ({
    name: operation.name,
    title: operationTitle(operation.name),
    ...(operation.description === "" ? {} : { description: operation.description }),
    effect: operation.effect,
    recommended: operation.effect === "reading"
  }));
}

/** Where the "may use" row offers the approved tools: what the type allows of the three. */
export function typedSurfaces(offer: ConnectorTypeOffer): ApprovalSurface[] {
  return APPROVAL_SURFACES.filter((surface) => offer.exposures.includes(surface));
}
