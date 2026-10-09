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

/** Names the secret that could not be resolved. It never carries a value or a file's contents. */
export class SecretNotResolvedError extends AppError {
  readonly secretName: string;

  constructor(secretName: string, reason: string) {
    super("VALIDATION_FAILED", `Secret '${secretName}' ${reason}`);
    this.name = "SecretNotResolvedError";
    this.secretName = secretName;
  }
}

/** Resolves a secret that an instance may leave unset. Any other failure is thrown. */
export async function resolveOptionalSecret(
  secrets: SecretResolver,
  name: string
): Promise<string | undefined> {
  try {
    return await secrets.resolve(name);
  } catch (error) {
    if (error instanceof SecretNotResolvedError) {
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
          `could not be read from the file named by '${fileVariable}'`
        );
      }
      const fromFile = contents.replace(/\r?\n$/u, "");
      if (!fromFile) {
        throw new SecretNotResolvedError(name, `is empty in the file named by '${fileVariable}'`);
      }
      return fromFile;
    }
  };
}

const SECRET_REF_MARK = Symbol.for("vivd-catalyst.secretRef");
// Upper case only, as environment variables are written. A pasted secret value almost never
// has this form, so it is refused here instead of being echoed back as a name.
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

/**
 * A config field that names a secret. The value in config is the name the resolver looks up,
 * never the secret itself, so a config file, the safe config view and a validation message can
 * all show it.
 */
export function secretRef(): z.ZodString {
  const schema = z
    .string()
    .regex(
      SECRET_NAME_PATTERN,
      "must be the name of a secret in upper case, digits and underscores, never its value"
    );
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
