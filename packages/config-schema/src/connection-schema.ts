import {
  CONNECTION_EXPOSURES,
  CONNECTION_MAX_ACCEPTED_OPERATIONS,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  CONNECTION_SERVICE_PATTERN,
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  CONNECTION_REFUSALS,
  CONNECTION_SECRET_HANDLE_PATTERN,
  CONNECTOR_TYPE_PATTERN,
  EGRESS_PROTOCOLS,
  WORKFLOW_ERROR_CODES,
  operationLimitsSchema,
  operationPagingSchema,
  secretRef,
  type ConnectionConfig,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { z } from "zod";

// The definition of a Connection as a revision holds it. Every object is strict: a field this
// schema does not name, such as a `secret` beside the handle, is refused and never stored.
//
// Where a secret may stand, and what guards it:
// - A secret reaches a Connection in one place only: release config names it by reference in
//   the one field `secret`. The value goes to the Secret Store and the revision holds a handle.
// - `settings` are typed by the Connector type. Its strict settings schema names every field it
//   reads, and a field it does not name is refused. A header or a query value that
//   authenticates is no setting: the connector auth component makes it from the secret.
// - The reading of names and shapes below (`findCredentialsInSettings`) is a second net under
//   that, not the boundary. It catches a pasted key in a field a type does accept as text.
// - `displayName` and `description` are free text for people. They are not read for
//   credentials and are shown as written, so nothing secret belongs in them.

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
  "secretkey",
  "accesskey",
  "passphrase",
  "signature",
  "jwt"
];
/** Short names that carry a credential only as the whole name. */
const CREDENTIAL_NAMES = ["key", "auth", "sig", "pwd", "pass", "bearer"];
/** What a name may end with after the word that counts: `tokenValue` is named like `token`. */
const CREDENTIAL_NAME_SUFFIX = /(?:value|val|string|text|data)$/u;
/** A value that is an `Authorization` header as it is sent. */
const AUTHORIZATION_VALUE_PATTERN = /^(?:bearer|basic)\s+\S/iu;
/** How deep settings are read. Deeper settings are refused, so nothing hides below the reading. */
const SETTINGS_MAX_DEPTH = 8;

function looksLikeCredentialName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return [plain, plain.replace(CREDENTIAL_NAME_SUFFIX, "")].some(
    (candidate) =>
      CREDENTIAL_NAMES.includes(candidate) ||
      CREDENTIAL_NAME_ENDINGS.some((ending) => candidate.endsWith(ending))
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

/** A switch, an absent value and an empty text hold nothing a credential could be. */
function carriesValue(value: JsonValue): boolean {
  return value !== null && typeof value !== "boolean" && value !== "";
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
      // A name alone carries nothing: `requiresToken: true` is a setting. Whatever else stands
      // under `token` is refused unread, a text as much as a number, a list or an object: a
      // credential split into parts or wrapped in an object is still one.
      if (carriesValue(entry) && looksLikeCredentialName(key)) {
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

/**
 * `paging` and `limits` of an operation are read so that their shape is fixed, and nothing
 * calls by them yet. A definition that names one is refused until the call path holds them:
 * stored and ignored, a limit would be believed and not kept.
 */
function refuseReservedFields(
  operation: { paging?: unknown; limits?: unknown },
  context: z.RefinementCtx,
  path: (string | number)[]
): void {
  for (const field of ["paging", "limits"] as const) {
    if (operation[field] !== undefined) {
      context.addIssue({
        code: "custom",
        path: [...path, field],
        message: `'${field}' on an operation of a Connection is not supported yet (${WORKFLOW_ERROR_CODES.notSupported})`
      });
    }
  }
}

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
    schemaFingerprint: z.string().min(1).max(200).optional(),
    /** How the outside system pages a reading operation. */
    paging: operationPagingSchema.optional(),
    /** How many calls toward the outside system run at once and start per period. */
    limits: operationLimitsSchema.optional()
  })
  .strict();

export const connectionConfigSchema: z.ZodType<ConnectionConfig, unknown> = z
  .object({
    name: connectionNameSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    service: z.string().regex(CONNECTION_SERVICE_PATTERN).optional(),
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
      refuseReservedFields(operation, context, ["operations", index]);
    }
  });

const releaseConnectionOperationSchema = z
  .object({
    name: connectionOperationSchema.shape.name,
    /** Required: the operator decides what an operation does, a hint of the system never. */
    effect: z.enum(["reading", "changing"]),
    exposure: z.array(z.enum(CONNECTION_EXPOSURES)).default([]),
    /** Only tightens: `deny` on any operation, `approval` on a changing one. */
    policy: z.enum(["deny", "approval"]).optional(),
    schemaFingerprint: z.string().min(1).max(200).optional(),
    /** How the outside system pages a reading operation. */
    paging: operationPagingSchema.optional(),
    /** How many calls toward the outside system run at once and start per period. */
    limits: operationLimitsSchema.optional()
  })
  .strict()
  .superRefine((operation, context) => {
    refuseReservedFields(operation, context, []);
  });

/**
 * One Connection of release config, `connections.<name>`. The start-up seed makes it an asset
 * with `origin: release`. Its `secret` is the name of a secret, never a value, and it is the
 * only place of the entry a secret is named in.
 */
export const releaseConnectionConfigSchema = z
  .object({
    connectorType: z.string().regex(CONNECTOR_TYPE_PATTERN),
    displayName: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    service: z.string().regex(CONNECTION_SERVICE_PATTERN).optional(),
    /** Read by the Connector type's own strict schema when the instance starts. */
    settings: settingsSchema.default({}),
    authScheme: z.string().min(1).max(64),
    secret: secretRef().optional(),
    /** The accepted list. An operation that is not listed is callable by nobody. */
    operations: z
      .array(releaseConnectionOperationSchema)
      .max(CONNECTION_MAX_ACCEPTED_OPERATIONS, {
        message: `A Connection accepts at most ${CONNECTION_MAX_ACCEPTED_OPERATIONS} operations (CONNECTION_MAX_ACCEPTED_OPERATIONS)`
      })
      .default([])
  })
  .strict();

export const releaseConnectionsConfigSchema = z
  .record(connectionNameSchema, releaseConnectionConfigSchema)
  .default({});

export type ReleaseConnectionConfig = z.infer<typeof releaseConnectionConfigSchema>;

const SECRET_STORE_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

/**
 * The keys of the Secret Store. Each `ref` names a secret that holds 32 random bytes in
 * base64. The first entry encrypts, every entry decrypts. A key is never part of config.
 */
export const secretStoreConfigSchema = z
  .object({
    keys: z
      .array(
        z
          .object({
            id: z.string().regex(SECRET_STORE_KEY_ID_PATTERN, {
              message: "A key id is lowercase letters, digits, hyphens or underscores"
            }),
            ref: secretRef()
          })
          .strict()
      )
      .default([])
  })
  .strict()
  .superRefine((secretStore, context) => {
    const seen = new Set<string>();
    for (const [index, key] of secretStore.keys.entries()) {
      if (seen.has(key.id)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "id"],
          message: `Duplicate key id: ${key.id}`
        });
      }
      seen.add(key.id);
    }
  })
  .prefault({});

/** A host of the list: one exact name or one literal address. No wildcard and no path. */
const EGRESS_HOST_PATTERN = /^(?:[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9_])?|[0-9a-f:.]{2,45})$/iu;
/** An IPv4 range, or one with a colon for IPv6. The egress checker reads it strictly at start. */
const EGRESS_CIDR_PATTERN =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}\/(?:\d|[12]\d|3[0-2])|(?=[0-9a-f.]*:)[0-9a-f:.]{2,45}\/\d{1,3})$/iu;

const egressAllowEntrySchema = z
  .object({
    protocol: z.enum(EGRESS_PROTOCOLS),
    host: z.string().regex(EGRESS_HOST_PATTERN, {
      message: "An egress host is one exact host name or address, without a wildcard"
    }),
    port: z.number().int().min(1).max(65_535),
    /**
     * `private` says the target is inside the operator's own network. Its addresses must then
     * lie in `cidrs`. A `public` target is refused when it resolves to an inside address.
     */
    network: z.enum(["public", "private"]).default("public"),
    cidrs: z
      .array(z.string().regex(EGRESS_CIDR_PATTERN, { message: "A range is written as a CIDR" }))
      .default([])
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.network === "private" && entry.cidrs.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["cidrs"],
        message: "A private target names the address ranges it lies in"
      });
    }
    if (entry.network === "public" && entry.cidrs.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["cidrs"],
        message: "Only a private target names address ranges"
      });
    }
    if (entry.protocol === "http" && entry.network !== "private") {
      context.addIssue({
        code: "custom",
        path: ["protocol"],
        message: "Plain http is allowed for a private target only. A public target uses https"
      });
    }
  });

/**
 * Where Connections may connect. Deny by default: an empty list refuses every target. Each
 * entry is one protocol, host and port.
 */
export const egressConfigSchema = z
  .object({ allow: z.array(egressAllowEntrySchema).default([]) })
  .strict()
  .prefault({});
