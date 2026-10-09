import { z } from "zod";
import { AppError } from "./errors";

/**
 * The one place a secret value is read. Config names a secret and never holds its value; a
 * provider takes its secrets from the resolver once, when it is created at startup.
 */
export interface SecretResolver {
  /** Resolves a secret by name. Throws `SecretNotResolvedError`, which names it and no value. */
  resolve(name: string): Promise<string>;
}

/**
 * Why a secret did not resolve. `absent` means nothing configures it, which an optional secret
 * may be. `unusable` means it is configured and broken, such as a mounted file that cannot be
 * read or is empty; that always stops startup.
 */
export type SecretNotResolvedKind = "absent" | "unusable";

/**
 * Names the secret that could not be resolved. It never carries a value or a file's contents,
 * and it repeats the name only when the name passes `isSecretName`: a credential pasted where a
 * name belongs is not echoed.
 */
export class SecretNotResolvedError extends AppError {
  readonly secretName: string | undefined;
  readonly kind: SecretNotResolvedKind;
  /** What went wrong, without the name: "is not set", "is empty in the file named by ...". */
  readonly reason: string;

  /** `reason` must not repeat the name unless the caller checked it with `isSecretName`. */
  constructor(secretName: string, reason: string, kind: SecretNotResolvedKind = "absent") {
    const printable = isSecretName(secretName) ? secretName : undefined;
    super(
      "VALIDATION_FAILED",
      printable ? `Secret '${printable}' ${reason}` : `A secret ${reason}`
    );
    this.name = "SecretNotResolvedError";
    this.secretName = printable;
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Resolves a secret that an instance may leave unset. Only a secret that nothing configures is
 * absent; one that is configured and cannot be read is thrown, as any other failure is.
 */
export async function resolveOptionalSecret(
  secrets: SecretResolver,
  name: string
): Promise<string | undefined> {
  try {
    return await secrets.resolve(name);
  } catch (error) {
    if (error instanceof SecretNotResolvedError && error.kind === "absent") {
      return undefined;
    }
    throw error;
  }
}

export type SecretEnvironment = Record<string, string | undefined>;

export interface EnvironmentSecretResolverInput {
  env: SecretEnvironment;
  /** Reads a mounted secret file. Passed in, so this package stays free of Node modules. */
  readSecretFile: (path: string) => Promise<string>;
}

/**
 * The `environment` secret provider: the variable `NAME`, and when it is absent the file named
 * by `NAME_FILE`, which is how a container runtime mounts a secret.
 */
export function createEnvironmentSecretResolver(
  input: EnvironmentSecretResolverInput
): SecretResolver {
  const { readSecretFile } = input;
  return {
    async resolve(name) {
      if (!isSecretName(name)) {
        throw new SecretNotResolvedError(
          name,
          `reference is refused: ${SECRET_NAME_EXPECTATION}`,
          "unusable"
        );
      }
      const value = input.env[name];
      if (value) {
        return value;
      }
      const fileVariable = `${name}_FILE`;
      const path = input.env[fileVariable];
      if (!path) {
        throw new SecretNotResolvedError(
          name,
          `is not set: neither the variable '${name}' nor '${fileVariable}' is present`
        );
      }
      let contents: string;
      try {
        contents = await readSecretFile(path);
      } catch {
        throw new SecretNotResolvedError(
          name,
          `could not be read from the file named by '${fileVariable}'`,
          "unusable"
        );
      }
      const fromFile = contents.replace(/\r?\n$/u, "");
      if (!fromFile) {
        throw new SecretNotResolvedError(
          name,
          `is empty in the file named by '${fileVariable}'`,
          "unusable"
        );
      }
      return fromFile;
    }
  };
}

const SECRET_REF_MARK = Symbol.for("vivd-catalyst.secretRef");
const SECRET_NAME_MAX_LENGTH = 64;
const SECRET_NAME_SINGLE_WORD_MAX_LENGTH = 12;
// A word of a name is short and carries at most two digits (`S3`, `E2E`, `OAUTH2`) or is a
// short number. A credential is one long run, or mixes many digits into its letters.
const SECRET_NAME_WORD = /^[A-Z0-9]{1,16}$/u;
const SECRET_NAME_WORD_MAX_DIGITS = 2;
// The shapes of well-known credentials, in any case: an AWS access key id, a GitHub token, a
// Google API key, a Slack token and a JSON Web Token. Each is the prefix with what follows it
// in a real credential, so a name such as GHOST_API_KEY or ASIA_MODEL_KEY is not one.
const CREDENTIAL_SHAPE =
  /^(?:(?:AKIA|ASIA)[A-Z0-9]{16}$|GH[OPRSU]_[A-Z0-9]{20,}|AIZA[A-Z0-9_-]{30,}|XOX[A-Z]-|EYJ[A-Z0-9_-]{16,})/iu;
/** Why a reference is refused as a secret name. It never repeats the reference. */
export const SECRET_NAME_EXPECTATION =
  "expected the name of an environment variable such as MODEL_API_KEY (upper-case words joined by underscores, at most 64 characters); the value given does not read as one and looks like a credential value";

/**
 * True for text that is safe to repeat as the name of a secret: it reads as an environment
 * variable name and not as a credential. Anything else is refused as a name and is never put
 * into a message, a log line or an error.
 */
export function isSecretName(value: string): boolean {
  if (value.length > SECRET_NAME_MAX_LENGTH || CREDENTIAL_SHAPE.test(value)) {
    return false;
  }
  const words = value.split("_");
  if (words.length === 1 && value.length > SECRET_NAME_SINGLE_WORD_MAX_LENGTH) {
    return false;
  }
  return /^[A-Z]/u.test(value) && words.every(isSecretNameWord);
}

function isSecretNameWord(word: string): boolean {
  if (!SECRET_NAME_WORD.test(word)) {
    return false;
  }
  const digits = word.replace(/[A-Z]/gu, "").length;
  return digits === word.length ? word.length <= 4 : digits <= SECRET_NAME_WORD_MAX_DIGITS;
}

/**
 * A config field that names a secret. The value in config is the name the resolver looks up,
 * never the secret itself, so a config file and a validation message can show it.
 */
export function secretRef(): z.ZodString {
  const schema = z.string().refine(isSecretName, SECRET_NAME_EXPECTATION);
  Object.defineProperty(schema, SECRET_REF_MARK, { value: true });
  return schema;
}

/** The fields of an object schema that are `secretRef()`, also behind a default or optional. */
export function secretRefFields(schema: z.ZodObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => isSecretRef(field))
    .map(([name]) => name);
}

function isSecretRef(schema: unknown): boolean {
  let current = schema;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if (SECRET_REF_MARK in current) {
      return true;
    }
    const inner: unknown =
      "def" in current && typeof current.def === "object" && current.def !== null
        ? Reflect.get(current.def, "innerType")
        : undefined;
    current = inner;
  }
  return false;
}
