import {
  CATALOGUE_ENTRY_ID_PATTERN,
  egressAllowEntrySchema,
  localizedStringSchema
} from "@work-shape/catalyst-config-schema";
import {
  CATALOGUE_CATEGORIES,
  CONNECTION_NAME_PATTERN,
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  CONNECTION_OPERATION_POLICIES,
  CONNECTION_SERVICE_PATTERN,
  CONNECTOR_TYPE_PATTERN,
  OPERATION_EFFECTS,
  type CataloguePart,
  type JsonObject,
  type JsonValue,
  type LocalizedStringConfig
} from "@work-shape/catalyst-core";
import { z } from "zod";

// A catalogue entry (CAT-1): data about one outside service, with up to two parts, `tools` for
// agents and `source` for a Knowledge Base. Each part installs one ordinary Connection. An
// entry holds no code, no grant, no exposure and no agent: every object below is strict, so a
// field this schema does not name, such as `exposure` on an operation or `grants` on a part,
// is refused when the release loads the entry. An entry only recommends; the admin enables.

/** The auth schemes an entry part may name in this cut: no sign-in of a person yet. */
const PART_AUTH_SCHEMES = ["none", "bearer", "header", "client_credentials"] as const;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

/** A colour as `#rrggbb`. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/iu;

/** The least contrast of the white initial on a mark's colour (WCAG AA for normal text). */
export const MARK_MIN_CONTRAST = 4.5;

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The contrast of white on the colour, from 1 to 21. */
export function whiteContrast(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** A logo file next to the entry: a drawing or a picture, small enough to send on every list. */
const LOGO_FILE = /^[a-z0-9][a-z0-9._-]{0,62}\.(svg|png)$/u;

/**
 * A mark is either a colour or the official logo with where the right to show it comes from.
 * One object with a check, so a refusal names the field that is wrong.
 */
const markSchema = z
  .object({
    /** The colour of the initial tile. The white initial must read on it. */
    color: z.string().regex(HEX_COLOUR, { message: "A colour is written #rrggbb" }).optional(),
    /** The vendor's official logo, a file next to the entry, shown unchanged. */
    logo: z
      .string()
      .regex(LOGO_FILE, { message: "A logo is an .svg or .png file next to the entry" })
      .optional(),
    /** Where the right to show it comes from: the guideline or agreement, who read it, when. */
    rights: z.string().trim().min(20).max(500).optional()
  })
  .strict()
  .superRefine((mark, context) => {
    if ((mark.color === undefined) === (mark.logo === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A mark is a colour or an official logo, one of them"
      });
    }
    if (mark.logo !== undefined && mark.rights === undefined) {
      context.addIssue({
        code: "custom",
        message: "An official logo names its rights: the guideline or agreement that permits it",
        path: ["rights"]
      });
    }
    if (mark.color !== undefined && mark.rights !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Rights belong to a logo, not to a colour",
        path: ["rights"]
      });
    }
    if (mark.color !== undefined && whiteContrast(mark.color) < MARK_MIN_CONTRAST) {
      context.addIssue({
        code: "custom",
        message: `The white initial needs a contrast of ${MARK_MIN_CONTRAST} on the mark's colour: choose a darker one`,
        path: ["color"]
      });
    }
  })
  .transform((mark): { color: string } | { logo: string; rights: string } =>
    mark.logo !== undefined
      ? { logo: mark.logo, rights: mark.rights ?? "" }
      : { color: mark.color ?? "" }
  );

/** A field the admin fills in: a setting by its dotted path, or the part's one secret. */
const fieldSchema = z
  .object({
    label: localizedStringSchema,
    help: localizedStringSchema.optional(),
    optional: z.literal(true).optional(),
    setting: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/u)
      .max(200)
      .optional(),
    secret: z.literal(true).optional(),
    /** What the field starts with. Never a secret. */
    default: z.string().max(2_048).optional()
  })
  .strict()
  .refine((field) => (field.setting === undefined) !== (field.secret === undefined), {
    message: "A field fills either one setting or the secret"
  })
  .refine((field) => field.secret === undefined || field.default === undefined, {
    message: "A secret field has no default",
    path: ["default"]
  });

/** One line of the checklist for the customer's IT, with a value to copy where it has one. */
const prerequisiteSchema = z
  .object({
    text: localizedStringSchema,
    value: z.string().trim().min(1).max(2_048).optional()
  })
  .strict();

const declaredParameterSchema = z
  .object({
    schema: z.record(z.string(), jsonValueSchema),
    description: z.string().max(1_000).optional(),
    required: z.boolean().optional()
  })
  .strict();

/**
 * An operation the entry proposes. Its effect is the entry's; `recommended` ticks a reading
 * one in the review step; `policy` may only tighten. The declaration (method, path,
 * parameters) is for a type whose Connections declare their operations, such as `http_api`.
 */
const operationSchema = z
  .object({
    name: z
      .string()
      .max(CONNECTION_OPERATION_NAME_MAX_LENGTH)
      .regex(CONNECTION_OPERATION_NAME_PATTERN),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(4_000).optional(),
    effect: z.enum(OPERATION_EFFECTS),
    recommended: z.boolean().default(false),
    policy: z.enum(CONNECTION_OPERATION_POLICIES).optional(),
    method: z
      .string()
      .regex(/^[A-Z]{1,16}$/u)
      .optional(),
    path: z.string().min(1).max(2_048).optional(),
    pathParams: z.record(z.string(), declaredParameterSchema).optional(),
    query: z.record(z.string(), declaredParameterSchema).optional()
  })
  .strict()
  .refine((operation) => !(operation.recommended && operation.effect !== "reading"), {
    message: "Only a reading operation is recommended: a changing one is never ticked in advance",
    path: ["recommended"]
  })
  .refine((operation) => !(operation.policy === "approval" && operation.effect !== "changing"), {
    message: "Only a changing operation can carry the policy 'approval'",
    path: ["policy"]
  });

const partSchema = z
  .object({
    connectorType: z.string().regex(CONNECTOR_TYPE_PATTERN),
    /** The default id of the Connection the part makes. */
    name: z.string().regex(CONNECTION_NAME_PATTERN).max(64),
    /** The default name of the Connection, in words. */
    title: localizedStringSchema.optional(),
    /** What the part does, on the step that prepares it. */
    description: localizedStringSchema,
    /** Whose account the Connection reads with. Only `shared` until personal connections. */
    credentialModes: z.array(z.literal("shared")).min(1).default(["shared"]),
    /** For a part with its own fields; a part over a type's form takes the form's. */
    authScheme: z.enum(PART_AUTH_SCHEMES).optional(),
    /** Fixed settings, beside what the fields fill in. */
    settings: z.record(z.string(), jsonValueSchema).optional(),
    /** The fields the admin fills in. Left out, the Connector type's own form gives them. */
    fields: z.array(fieldSchema).max(12).optional(),
    prerequisites: z.array(prerequisiteSchema).max(12).default([]),
    /** The hosts the part reaches. A named entry adds them to the instance's egress list. */
    egress: z.array(egressAllowEntrySchema).min(1).max(8),
    operations: z
      .array(operationSchema)
      .max(64)
      .default([])
      .refine(
        (operations) => new Set(operations.map((entry) => entry.name)).size === operations.length,
        { message: "An operation is listed once" }
      ),
    /** Said before the secret or sign-in: whose account it is and who reads what it reads. */
    sharedAccountNote: localizedStringSchema
  })
  .strict()
  .refine((part) => (part.fields === undefined) === (part.authScheme === undefined), {
    message: "A part names its auth scheme exactly where it names its own fields",
    path: ["authScheme"]
  })
  .refine((part) => (part.fields ?? []).filter((field) => field.secret).length <= 1, {
    message: "A part asks for one secret at most",
    path: ["fields"]
  });

export const catalogueEntrySchema = z
  .object({
    id: z.string().regex(CATALOGUE_ENTRY_ID_PATTERN),
    version: z.number().int().min(1),
    /** The `service` of the Connections it makes. */
    service: z.string().regex(CONNECTION_SERVICE_PATTERN),
    title: localizedStringSchema,
    description: localizedStringSchema,
    category: z.enum(CATALOGUE_CATEGORIES),
    examplePrompts: z.array(localizedStringSchema).min(1).max(5),
    mark: markSchema,
    tools: partSchema
      .refine((part) => part.operations.length > 0, {
        message: "A tools part proposes at least one operation",
        path: ["operations"]
      })
      .optional(),
    source: partSchema
      .refine((part) => part.operations.length === 0, {
        message:
          "A source part has no operations: its documents reach people through a Knowledge Base",
        path: ["operations"]
      })
      .optional()
  })
  .strict()
  .refine((entry) => entry.tools !== undefined || entry.source !== undefined, {
    message: "An entry brings tools, a source or both"
  });

type ParsedEntry = z.infer<typeof catalogueEntrySchema>;
export type CatalogueEntryPart = NonNullable<ParsedEntry["tools"]>;
export type CatalogueEntryOperation = CatalogueEntryPart["operations"][number];
export type CatalogueEntryField = NonNullable<CatalogueEntryPart["fields"]>[number];

/**
 * A loaded entry. Its mark carries the logo as an address the browser draws, read from the file
 * next to the entry; the file name itself goes no further.
 */
export type CatalogueEntry = Omit<ParsedEntry, "mark"> & {
  mark: { color: string; logo?: undefined } | { logo: string; rights: string; color?: undefined };
};

/** The parts of an entry, in the order a card names them. */
export function entryParts(
  entry: Pick<CatalogueEntry, "tools" | "source">
): { part: CataloguePart; definition: CatalogueEntryPart }[] {
  return [
    ...(entry.tools ? [{ part: "tools" as const, definition: entry.tools }] : []),
    ...(entry.source ? [{ part: "source" as const, definition: entry.source }] : [])
  ];
}

/** The settings of a part as JSON: what the YAML wrote, which holds nothing but JSON. */
export function partSettings(part: CatalogueEntryPart): JsonObject {
  return structuredClone(part.settings ?? {});
}

export type { LocalizedStringConfig };
