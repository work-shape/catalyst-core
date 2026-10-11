import {
  CONNECTION_EXPOSURES,
  CONNECTION_MAX_ACCEPTED_OPERATIONS,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  CONNECTION_REFUSALS,
  CONNECTION_SECRET_HANDLE_PATTERN,
  CONNECTOR_TYPE_PATTERN,
  type ConnectionConfig,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { z } from "zod";

// The definition of a Connection as a revision holds it. Every object is strict: a field this
// schema does not name, such as a `secret` beside the handle, is refused and never stored.

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

const settingsSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/**
 * Names that carry a credential, compared without case and punctuation. A settings key or a
 * query parameter is refused when its name is one of these or ends with one.
 */
const CREDENTIAL_NAME_ENDINGS = [
  "authorization",
  "cookie",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "signature"
];
/** Short names that carry a credential only as the whole name. */
const CREDENTIAL_NAMES = ["key", "auth", "sig", "pwd", "pass", "bearer"];
/** A value that is an `Authorization` header as it is sent. */
const AUTHORIZATION_VALUE_PATTERN = /^(?:bearer|basic)\s+\S/iu;
/** How deep settings are read. Deeper settings are refused, so nothing hides below the reading. */
const SETTINGS_MAX_DEPTH = 8;

function looksLikeCredentialName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    CREDENTIAL_NAMES.includes(plain) ||
    CREDENTIAL_NAME_ENDINGS.some((ending) => plain.endsWith(ending))
  );
}

/** Why a text is refused as a setting, or nothing. The answer never repeats the text. */
function credentialInText(text: string): string | undefined {
  if (AUTHORIZATION_VALUE_PATTERN.test(text)) {
    return "holds an Authorization value";
  }
  if (!text.includes("://")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Not an address this runtime reads. Its userinfo is still told by its shape.
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu.test(text)
      ? "is an address with a user name or a password"
      : undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return "is an address with a user name or a password";
  }
  for (const parameter of url.searchParams.keys()) {
    if (looksLikeCredentialName(parameter)) {
      return "is an address with a query parameter that looks like a credential";
    }
  }
  return undefined;
}

export interface CredentialInSettings {
  path: (string | number)[];
  /** What was found, in words that repeat no value. */
  finding: string;
}

/**
 * The places in a Connection's settings that look like a credential: an address with userinfo,
 * a header or a key named like a credential, a query parameter named like one, an
 * `Authorization` value. It reads names and shapes, so it proves no setting free of a secret:
 * a Connector type's own settings schema names the fields it accepts.
 */
export function findCredentialsInSettings(settings: JsonObject): CredentialInSettings[] {
  const found: CredentialInSettings[] = [];
  const read = (value: JsonValue, path: (string | number)[]): void => {
    if (path.length > SETTINGS_MAX_DEPTH) {
      found.push({ path, finding: `is nested deeper than ${SETTINGS_MAX_DEPTH} levels` });
      return;
    }
    if (typeof value === "string") {
      const finding = credentialInText(value);
      if (finding !== undefined) found.push({ path, finding });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => read(entry, [...path, index]));
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      // A name alone carries nothing: `requiresToken: true` is a setting, a text under
      // `token` is a credential.
      if (typeof entry === "string" && entry !== "" && looksLikeCredentialName(key)) {
        found.push({ path: [...path, key], finding: "is named like a credential" });
        continue;
      }
      read(entry, [...path, key]);
    }
  };
  read(settings, []);
  return found;
}

export const connectionNameSchema = z
  .string()
  .max(CONNECTION_NAME_MAX_LENGTH)
  .regex(CONNECTION_NAME_PATTERN, { message: CONNECTION_NAME_RULE });

const connectionOperationSchema = z
  .object({
    name: z
      .string()
      .max(CONNECTION_OPERATION_NAME_MAX_LENGTH)
      .regex(CONNECTION_OPERATION_NAME_PATTERN, {
        message:
          "Operation name must start with a letter and contain only letters, numbers, underscores, or hyphens"
      }),
    /** Required: no operation of a Connection exists without an effect. */
    effect: z.enum(["reading", "changing"]),
    exposure: z.array(z.enum(CONNECTION_EXPOSURES)).default([]),
    enabled: z.boolean().default(true),
    policy: z.enum(["deny", "approval"]).optional(),
    schemaFingerprint: z.string().min(1).max(200).optional()
  })
  .strict();

export const connectionConfigSchema: z.ZodType<ConnectionConfig, unknown> = z
  .object({
    name: connectionNameSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    connectorType: z.string().regex(CONNECTOR_TYPE_PATTERN),
    ownerPrincipalId: z.string().min(1),
    settings: settingsSchema.default({}),
    authScheme: z.string().min(1).max(64),
    credentialMode: z.literal("shared").default("shared"),
    secretHandle: z
      .string()
      .regex(CONNECTION_SECRET_HANDLE_PATTERN, {
        // The value is never repeated: what stands here may be a key somebody pasted.
        message: "secretHandle must be a handle of the Secret Store, never a secret"
      })
      .optional(),
    operations: z
      .array(connectionOperationSchema)
      .max(CONNECTION_MAX_ACCEPTED_OPERATIONS, {
        message: `A Connection accepts at most ${CONNECTION_MAX_ACCEPTED_OPERATIONS} operations (CONNECTION_MAX_ACCEPTED_OPERATIONS)`
      })
      .default([]),
    enabled: z.boolean().default(true),
    origin: z.enum(["release", "runtime"])
  })
  .strict()
  .superRefine((connection, context) => {
    for (const { path, finding } of findCredentialsInSettings(connection.settings)) {
      context.addIssue({
        code: "custom",
        path: ["settings", ...path],
        message: `${CONNECTION_REFUSALS.credentialInSettings}: the setting ${finding}. A credential belongs in the Secret Store`
      });
    }
    const seen = new Set<string>();
    for (const [index, operation] of connection.operations.entries()) {
      if (seen.has(operation.name)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "name"],
          message: `Duplicate operation: ${operation.name}`
        });
      }
      seen.add(operation.name);
      if (new Set(operation.exposure).size !== operation.exposure.length) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "exposure"],
          message: "An exposure is listed once"
        });
      }
      // A policy only tightens. A reading operation runs or is denied; only a changing one
      // can wait for an approval.
      if (operation.policy === "approval" && operation.effect !== "changing") {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "policy"],
          message: "Only a changing operation can carry the policy 'approval'"
        });
      }
    }
  });
