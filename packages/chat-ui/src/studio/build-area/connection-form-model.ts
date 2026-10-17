import { OPERATION_EFFECTS } from "@work-shape/catalyst-core";
// The form of a Connection made on the instance, and what it writes. Pure: the page holds the
// state, these functions read and make definitions. No function here holds a credential: the
// secret is entered beside the definition and sent on its own.

/** The Connector types a person connects by address and key: a remote MCP server, a REST API. */
export type ConnectionFormType = "mcp" | "http_api";

/** How the instance proves itself to the server, as the form offers it. */
export const CONNECTION_AUTH_CHOICES = ["none", "bearer", "header"] as const;
export type ConnectionAuthChoice = (typeof CONNECTION_AUTH_CHOICES)[number];

/**
 * The auth scheme as the form holds it: a choice, or `oauth`, which a Connection takes when its
 * server asks for a sign-in. The form offers `oauth` only to a Connection that has it, and keeps
 * its `settings.oauth` while it stays.
 */
export type ConnectionFormAuthScheme = ConnectionAuthChoice | "oauth";

/** A fixed header of a REST API, as the form lists it: never a credential. */
export interface ConnectionHeaderRow {
  name: string;
  value: string;
}

export interface ConnectionFormState {
  connectorType: ConnectionFormType;
  /** The address: the MCP server's `url`, or the REST API's `baseUrl`. */
  url: string;
  authScheme: ConnectionFormAuthScheme;
  /** With `header`: the header that carries the secret. */
  headerName: string;
  /** For `http_api`: the fixed headers sent with every request. */
  headers: ConnectionHeaderRow[];
  /** For `http_api`: the path the test asks, or empty for the base address. */
  testPath: string;
}

/** One operation a write accepts, as the definition holds it. */
interface AcceptedOperation {
  name: string;
  effect: (typeof OPERATION_EFFECTS)[number];
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

function authChoiceOf(value: unknown): ConnectionFormAuthScheme {
  if (value === "oauth") return "oauth";
  return CONNECTION_AUTH_CHOICES.find((choice) => choice === value) ?? "none";
}

/** The form of a stored or copied definition. */
export function connectionConfigToForm(config: Record<string, unknown>): ConnectionFormState {
  const settings = recordOf(config.settings);
  const connectorType = config.connectorType === "http_api" ? "http_api" : "mcp";
  return {
    connectorType,
    url: textOf(connectorType === "http_api" ? settings.baseUrl : settings.url),
    authScheme: authChoiceOf(config.authScheme),
    headerName: textOf(settings.headerName),
    headers: Object.entries(recordOf(settings.headers)).map(([name, value]) => ({
      name,
      value: textOf(value)
    })),
    testPath: textOf(settings.testPath)
  };
}

/** The form of a new Connection: a server without a credential, until one is chosen. */
export function emptyConnectionForm(
  connectorType: ConnectionFormType = "mcp"
): ConnectionFormState {
  return {
    connectorType,
    url: "",
    authScheme: "bearer",
    headerName: "",
    headers: [],
    testPath: ""
  };
}

/** The fixed headers of the form that name a header, by name. A row left empty is no header. */
function headersOf(rows: readonly ConnectionHeaderRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => [row.name.trim(), row.value.trim()] as const).filter(([name]) => name !== "")
  );
}

/** The origin of an address, to tell whether a change of it moves the key elsewhere. */
export function addressOrigin(url: string): string | undefined {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

/** Whether the auth scheme sends a secret, which the form then asks for. */
export function sendsSecret(authScheme: ConnectionFormAuthScheme): boolean {
  // A sign-in's client secret is entered with the sign-in, not as a key.
  return authScheme === "bearer" || authScheme === "header";
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
  const credentialHeader = form.authScheme === "header" && headerName !== "" ? { headerName } : {};
  if (form.connectorType === "mcp") {
    const oauth = recordOf(config.settings).oauth;
    // The sign-in's client and permissions stay while the Connection signs in.
    const signIn = form.authScheme === "oauth" && oauth !== undefined ? { oauth } : {};
    return {
      ...config,
      settings: { url: form.url.trim(), ...credentialHeader, ...signIn },
      authScheme: form.authScheme
    };
  }
  const headers = headersOf(form.headers);
  const testPath = form.testPath.trim();
  return {
    ...config,
    settings: {
      baseUrl: form.url.trim(),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(testPath === "" ? {} : { testPath }),
      ...credentialHeader
    },
    authScheme: form.authScheme
  };
}

/**
 * The definition of a new Connection: a server that accepts no operation until its tools are
 * discovered or declared, and approved. A copy keeps the operations of the Connection it copies. The
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
      connectorType: form.connectorType,
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

/** One operation a person approved: as it was discovered or declared. */
export interface ApprovedOperation {
  name: string;
  effect: (typeof OPERATION_EFFECTS)[number];
  /** For a discovered tool: the fingerprint of the description the person saw. */
  schemaFingerprint?: string;
  /** For a declared operation: its declaration, such as the method, the path and the parameters. */
  declaration?: Record<string, unknown>;
}

/**
 * The definition with the operations a person approved at once, each open to the surfaces of
 * the one "may use" row and switched on. A discovered tool is pinned to the fingerprint the
 * person saw, so a later description of it waits for a review. Every other operation stays.
 */
export function withApprovedOperations(
  config: Record<string, unknown>,
  approved: readonly ApprovedOperation[],
  exposure: readonly string[]
): Record<string, unknown> {
  const names = new Set(approved.map((operation) => operation.name));
  return {
    ...config,
    operations: [
      ...acceptedOperationsOf(config).filter((entry) => !names.has(entry.name)),
      ...approved.map((operation) => ({
        ...operation.declaration,
        name: operation.name,
        effect: operation.effect,
        exposure: [...exposure],
        enabled: true,
        ...(operation.schemaFingerprint === undefined
          ? {}
          : { schemaFingerprint: operation.schemaFingerprint })
      }))
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

/**
 * The definition with one accepted operation exposed to the surface or no longer, and every
 * other exposure of it as it was.
 */
export function withOperationExposure(
  config: Record<string, unknown>,
  name: string,
  exposure: string,
  exposed: boolean
): Record<string, unknown> {
  return {
    ...config,
    operations: acceptedOperationsOf(config).map((operation) => {
      if (operation.name !== name) return operation;
      const others = operation.exposure.filter((surface) => surface !== exposure);
      return { ...operation, exposure: exposed ? [...others, exposure] : others };
    })
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
    Number(headerCounts && form.headerName.trim() !== baseline.headerName.trim()) +
    Number(
      JSON.stringify(headersOf(form.headers)) !== JSON.stringify(headersOf(baseline.headers))
    ) +
    Number(form.testPath.trim() !== baseline.testPath.trim())
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
