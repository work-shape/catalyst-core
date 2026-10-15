import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { z } from "zod";
import { egressTargetOfUrl } from "@work-shape/catalyst-connections";
import type {
  ConnectionCredential,
  ConnectorContext,
  ConnectorTypeDefinition,
  JsonValue
} from "@work-shape/catalyst-core";
import { withTestSql } from "./test-sql";

// The Connector type of the Connection tests. It reaches nothing by itself: it records what
// it was handed, so a test can say whether `execute` ran and with which credential.

interface TestConnectorCall {
  operation: string;
  input: JsonValue;
  context: ConnectorContext;
  /** What the auth component handed the type for the checked target. */
  credential: ConnectionCredential | undefined;
}

export interface TestConnector {
  readonly type: ConnectorTypeDefinition;
  /** Every `execute` that ran, in order. */
  readonly calls: TestConnectorCall[];
}

/**
 * Settings as a real type declares them: strict, with every field named. `headerName` is the
 * name of the header the secret goes into under the auth scheme `header`, never its value.
 */
const settingsSchema = z
  .object({
    url: z.string().url(),
    headerName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]*$/u)
      .optional()
  })
  .strict();

export function createTestConnector(): TestConnector {
  const calls: TestConnectorCall[] = [];
  const readUrl = (settings: Record<string, JsonValue>) => settingsSchema.parse(settings).url;
  const type: ConnectorTypeDefinition = {
    type: "test",
    description: "Records its calls. For tests.",
    settingsSchema,
    authSchemes: ["none", "bearer", "header"],
    secretFields: ["token"],
    target: (settings) => egressTargetOfUrl(readUrl(settings)),
    credentialHeaderName: (settings) => settingsSchema.parse(settings).headerName,
    catalog: [
      {
        name: "echo",
        description: "Returns its input.",
        inputSchema: { type: "object" },
        proposedEffect: "reading"
      }
    ],
    test: () => Promise.resolve({ status: "ready" }),
    execute(operation, input, context) {
      calls.push({ operation, input, context, credential: context.credentialFor(context.target) });
      return Promise.resolve(input);
    },
    limits: { callTimeoutMs: 1000, resultMaxBytes: 1024, maxParallelCalls: 1 }
  };
  return { type, calls };
}

/** A Secret Store key as release config expects one: 32 random bytes in base64. */
export function generateSecretStoreKey(): string {
  return randomBytes(32).toString("base64");
}

/** A secret of a test, random so that a search for it finds no accident. */
export function generateTestSecret(): string {
  return `tk_${randomBytes(24).toString("base64url")}`;
}

/**
 * The ways a value may appear in text that was meant not to hold it: as it is, escaped as
 * JSON, as base64 in both alphabets, as hex, and as any slice of twelve characters of each.
 */
function leakedForms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  const bytes = Buffer.from(value, "utf8");
  const whole = [
    value,
    escaped,
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/u, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    encodeURIComponent(value)
  ];
  const forms = new Set(whole);
  // Base64 of a value that starts inside another text shifts by one or two bytes.
  for (const shift of [1, 2]) {
    forms.add(bytes.subarray(shift).toString("base64").replace(/=+$/u, "").slice(0, -2));
  }
  for (const form of whole) {
    for (let start = 0; start + 12 <= form.length; start += 1) {
      forms.add(form.slice(start, start + 12));
    }
  }
  return [...forms].filter((form) => form.length >= 12);
}

/** The first form of `value` found in `text`, or nothing. */
export function findLeak(text: string, value: string): string | undefined {
  return leakedForms(value).find((form) => text.includes(form));
}

/**
 * Every row of every table of the test database as one text. A binary column is written
 * three ways, as text, as hex and as base64, so a value stored in the clear is found in it.
 */
export async function dumpDatabaseText(): Promise<string> {
  return withTestSql(async (sql) => {
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' order by tablename`;
    const parts: string[] = [];
    for (const { tablename } of tables) {
      const rows = await sql.unsafe(`select * from "${tablename.replaceAll('"', '""')}"`);
      parts.push(
        tablename,
        JSON.stringify(rows, (_key, value: unknown) => {
          const bytes = binaryOf(value);
          return bytes
            ? [bytes.toString("latin1"), bytes.toString("hex"), bytes.toString("base64")]
            : value;
        })
      );
    }
    return parts.join("\n");
  });
}

/** A binary value as the driver or `JSON.stringify` hands it over. */
function binaryOf(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "Buffer" &&
    "data" in value &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data.filter((byte): byte is number => typeof byte === "number"));
  }
  return undefined;
}

/**
 * Captures what the process writes to stdout and stderr, which is where the instance's
 * logger and every `console` call end up. `stop` restores both and answers the text.
 */
export function captureProcessOutput(): { stop(): string } {
  const written: string[] = [];
  const spies = [process.stdout, process.stderr].map((stream) =>
    vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    })
  );
  return {
    stop() {
      for (const spy of spies) spy.mockRestore();
      return written.join("");
    }
  };
}
