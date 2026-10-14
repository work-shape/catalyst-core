// The form of a Connection made on the instance, and what it writes. Pure: the page holds the
// state, these functions read and make definitions. No function here holds a credential: the
// secret is entered beside the definition and sent on its own.

/** The Connector type this form makes: a remote MCP server. */
const MCP_CONNECTOR_TYPE = "mcp";

/** How the instance proves itself to the server, as the form offers it. */
export const CONNECTION_AUTH_CHOICES = ["none", "bearer", "header"] as const;
export type ConnectionAuthChoice = (typeof CONNECTION_AUTH_CHOICES)[number];

export interface ConnectionFormState {
  url: string;
  authScheme: ConnectionAuthChoice;
  /** With `header`: the header that carries the secret. */
  headerName: string;
}

/** One operation a write accepts, as the definition holds it. */
interface AcceptedOperation {
  name: string;
  effect: "reading" | "changing";
  exposure: string[];
  enabled: boolean;
  schemaFingerprint?: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function authChoiceOf(value: unknown): ConnectionAuthChoice {
  return CONNECTION_AUTH_CHOICES.find((choice) => choice === value) ?? "none";
}

/** The form of a stored or copied definition. */
export function connectionConfigToForm(config: Record<string, unknown>): ConnectionFormState {
  const settings = recordOf(config.settings);
  return {
    url: textOf(settings.url),
    authScheme: authChoiceOf(config.authScheme),
    headerName: textOf(settings.headerName)
  };
}

/** The form of a new Connection: a server without a credential, until one is chosen. */
export function emptyConnectionForm(): ConnectionFormState {
  return { url: "", authScheme: "bearer", headerName: "" };
}

/** Whether the auth scheme sends a secret, which the form then asks for. */
export function sendsSecret(authScheme: ConnectionAuthChoice): boolean {
  return authScheme !== "none";
}

/**
 * The definition with the form's address and auth scheme, and everything else as it was. The
 * header name is only written for the scheme that reads it.
 */
export function withConnectionForm(
  config: Record<string, unknown>,
  form: ConnectionFormState
): Record<string, unknown> {
  const headerName = form.headerName.trim();
  return {
    ...config,
    settings: {
      url: form.url.trim(),
      ...(form.authScheme === "header" && headerName !== "" ? { headerName } : {})
    },
    authScheme: form.authScheme
  };
}

/**
 * The definition of a new Connection: an MCP server that accepts no operation until its tools
 * are discovered and accepted. A copy keeps the operations of the Connection it copies. The
 * instance writes the origin, the owner and the secret handle itself.
 */
export function newConnectionConfig(
  start: { name: string; title: string; copyOf?: Record<string, unknown> },
  form: ConnectionFormState
): Record<string, unknown> {
  const copied = start.copyOf ?? {};
  const description = textOf(copied.description);
  return withConnectionForm(
    {
      name: start.name,
      displayName: start.title,
      ...(description === "" ? {} : { description }),
      connectorType: MCP_CONNECTOR_TYPE,
      operations: acceptedOperationsOf(copied),
      enabled: true
    },
    form
  );
}

/** The accepted operations of a definition, each with the members the form keeps. */
function acceptedOperationsOf(config: Record<string, unknown>): AcceptedOperation[] {
  const { operations } = config;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((entry): AcceptedOperation[] => {
    const operation = recordOf(entry);
    const name = textOf(operation.name);
    if (name === "") return [];
    const fingerprint = textOf(operation.schemaFingerprint);
    return [
      {
        ...operation,
        name,
        effect: operation.effect === "changing" ? "changing" : "reading",
        exposure: Array.isArray(operation.exposure)
          ? operation.exposure.filter((surface): surface is string => typeof surface === "string")
          : [],
        enabled: operation.enabled !== false,
        ...(fingerprint === "" ? {} : { schemaFingerprint: fingerprint })
      }
    ];
  });
}

/**
 * The definition with one more accepted operation: the tool as it was discovered, pinned to
 * the fingerprint the reader saw, so a later description of it waits for a review.
 */
export function withAcceptedOperation(
  config: Record<string, unknown>,
  operation: {
    name: string;
    effect: "reading" | "changing";
    fingerprint: string;
    forAgents: boolean;
  }
): Record<string, unknown> {
  const others = acceptedOperationsOf(config).filter((entry) => entry.name !== operation.name);
  return {
    ...config,
    operations: [
      ...others,
      {
        name: operation.name,
        effect: operation.effect,
        exposure: operation.forAgents ? ["agent"] : [],
        enabled: true,
        schemaFingerprint: operation.fingerprint
      }
    ]
  };
}

/** The definition with an accepted operation pinned to the description that was read now. */
export function withReviewedOperation(
  config: Record<string, unknown>,
  name: string,
  fingerprint: string
): Record<string, unknown> {
  return {
    ...config,
    operations: acceptedOperationsOf(config).map((operation) =>
      operation.name === name ? { ...operation, schemaFingerprint: fingerprint } : operation
    )
  };
}

/** The definition without one accepted operation. Nobody can call it afterwards. */
export function withoutOperation(
  config: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  return {
    ...config,
    operations: acceptedOperationsOf(config).filter((operation) => operation.name !== name)
  };
}

/** How many fields of the form differ from what was loaded. */
export function countConnectionFormChanges(
  form: ConnectionFormState,
  baseline: ConnectionFormState
): number {
  const headerCounts = form.authScheme === "header" || baseline.authScheme === "header";
  return (
    Number(form.url.trim() !== baseline.url.trim()) +
    Number(form.authScheme !== baseline.authScheme) +
    Number(headerCounts && form.headerName.trim() !== baseline.headerName.trim())
  );
}

/** How long a page waits for a discovery it asked for, at most. */
export const DISCOVERY_WAIT_MS = 90_000;

/** A discovery a page waits for: since when, and the catalog it had then. */
export interface DiscoveryWait {
  since: number;
  /** When the catalog the page had was read. Nothing where it had none. */
  discoveredAt?: string;
}

/**
 * Whether a page still waits: no catalog is in that is newer than the one it had, and the wait
 * is not over. A changed address drops the catalog, which is no new one.
 */
export function waitsForDiscovery(
  wait: DiscoveryWait,
  detail: { discoveredAt?: string },
  now: number
): boolean {
  const unchanged = detail.discoveredAt === undefined || detail.discoveredAt === wait.discoveredAt;
  return unchanged && now - wait.since < DISCOVERY_WAIT_MS;
}
