import { z } from "zod";
import { egressTargetOfUrl } from "@vivd-catalyst/connections";
import type {
  ConnectorContext,
  ConnectorOperationDescriptor,
  ConnectorTypeDefinition,
  JsonValue
} from "@vivd-catalyst/core";

// A Connector type that reads its operations from an outside system, for the tests of the
// discovery. It reaches nothing: `discover` answers what the test sets, and the type records
// what it was asked.

export interface DiscoveringTestConnector {
  readonly type: ConnectorTypeDefinition;
  /** What the outside system lists now. A test replaces it. */
  discover: (context: ConnectorContext) => Promise<readonly ConnectorOperationDescriptor[]>;
  /** How often `discover` ran. */
  discoveries: number;
  /** The secret each `discover` was handed for the checked target. */
  readonly handed: (string | undefined)[];
  /** Every `execute` that ran, in order. */
  readonly calls: { operation: string; input: JsonValue }[];
}

const settingsSchema = z.object({ url: z.string().url() }).strict();

/** An operation as an outside system lists one. */
export function listedOperation(
  name: string,
  overrides: Partial<ConnectorOperationDescriptor> = {}
): ConnectorOperationDescriptor {
  return {
    name,
    description: `Reads ${name}.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false
    },
    proposedEffect: "reading",
    ...overrides
  };
}

export function createDiscoveringTestConnector(
  listed: readonly ConnectorOperationDescriptor[] = []
): DiscoveringTestConnector {
  const connector: DiscoveringTestConnector = {
    type: {
      type: "discovering",
      description: "Lists what the test sets. For tests.",
      settingsSchema,
      authSchemes: ["none", "bearer"],
      secretFields: ["token"],
      target: (settings) => egressTargetOfUrl(settingsSchema.parse(settings).url),
      discover(context) {
        connector.discoveries += 1;
        connector.handed.push(context.credentialFor(context.target)?.secret);
        return connector.discover(context);
      },
      test: () => Promise.resolve({ status: "ready" }),
      execute(operation, input) {
        connector.calls.push({ operation, input });
        return Promise.resolve(input);
      },
      limits: { callTimeoutMs: 1000, resultMaxBytes: 1024, maxParallelCalls: 1 }
    },
    discover: () => Promise.resolve(listed),
    discoveries: 0,
    handed: [],
    calls: []
  };
  return connector;
}
