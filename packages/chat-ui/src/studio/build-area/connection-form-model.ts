import {
  CONNECTOR_TOKEN_AUTH_METHODS,
  OPERATION_EFFECTS,
  type ConnectionCredentialMode,
  type ConnectorTokenAuthMethod
} from "@work-shape/catalyst-core";
// The form of a Connection made on the instance, and what it writes. Pure: the page holds the
// state, these functions read and make definitions. No function here holds a credential: the
// secret is entered beside the definition and sent on its own.

/** The Connector types a person connects by address and key: a remote MCP server, a REST API. */
export type ConnectionFormType = "mcp" | "http_api";

/** How the instance proves itself to the server, as the form offers it. */
export const CONNECTION_AUTH_CHOICES = ["none", "bearer", "header"] as const;
export type ConnectionAuthChoice = (typeof CONNECTION_AUTH_CHOICES)[number];

/**
 * The auth schemes of a REST API that names its authorization server (CONN-OAUTH-1): a person
 * signs in (`oauth`), or the instance signs in as its own client (`oauth_client`).
 */
export const CONNECTION_OAUTH_CHOICES = ["oauth", "oauth_client"] as const;
export type ConnectionOAuthChoice = (typeof CONNECTION_OAUTH_CHOICES)[number];

/**
 * The auth scheme as the form holds it: a choice, or `oauth`, which an MCP Connection takes when
 * its server asks for a sign-in, or a REST API's OAuth choice. The form offers `oauth` to an MCP
 * Connection only where it has it, and keeps its `settings.oauth` while it stays.
 */
export type ConnectionFormAuthScheme = ConnectionAuthChoice | ConnectionOAuthChoice;

/**
 * Whose account a Connection that signs a person in uses: one account for everyone (`shared`),
 * or each person's own (`user`). Fixed once the Connection is made.
 */
export type { ConnectionCredentialMode };

/**
 * Whether the form offers the choice of whose account: only where a person signs in with
 * OAuth, an MCP server, which signs in once its server asks, or a REST API's sign-in.
 */
export function offersCredentialMode(
  connectorType: ConnectionFormType,
  auth: "key" | ConnectionOAuthChoice
): boolean {
  return connectorType === "mcp" || auth === "oauth";
}

/** The mode a definition names. A definition without one shares its account. */
export function credentialModeOf(config: Record<string, unknown>): ConnectionCredentialMode {
  return config.credentialMode === "user" ? "user" : "shared";
}

/**
 * Whether an MCP server or a REST API accepts no tool yet, and so gives nothing to anyone: it
 * is incomplete, such as one a failed connect left behind. The list reads the same from the
 * instance's `withoutTools`.
 */
export function isIncompleteConnection(config: Record<string, unknown>): boolean {
  const { connectorType, operations } = config;
  return (
    (connectorType === "mcp" || connectorType === "http_api") &&
    (!Array.isArray(operations) || operations.length === 0)
  );
}

/** The fields of the New connection dialog for a stored MCP server or REST API. */
export function connectionFormFieldsOf(config: Record<string, unknown>): {
  title: string;
  description: string;
  form: ConnectionFormState;
  credentialMode: ConnectionCredentialMode;
} {
  return {
    title: textOf(config.displayName) || textOf(config.name),
    description: textOf(config.description),
    form: connectionConfigToForm(config),
    credentialMode: credentialModeOf(config)
  };
}

/** How a REST API's client proves itself at the token endpoint. */
export const CONNECTION_TOKEN_AUTH_METHODS = CONNECTOR_TOKEN_AUTH_METHODS;
export type ConnectionTokenAuthMethod = ConnectorTokenAuthMethod;

/**
 * The authorization server a REST API names, as the form holds it. The client secret is not
 * here: it is the Connection's own secret, entered beside the definition.
 */
export interface ConnectionOAuthForm {
  /** Where a person signs in. Only `oauth` reads it. */
  authorizationUrl: string;
  tokenUrl: string;
  /** Empty for none: a disconnect then forgets the sign-in without telling the provider. */
  revocationUrl: string;
  clientId: string;
  /** The permissions asked for, separated by spaces, as typed. */
  scopes: string;
  /** Fixed extra parameters of the authorization address, such as `prompt`. */
  params: ConnectionHeaderRow[];
  tokenAuthMethod: ConnectionTokenAuthMethod;
}

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
  /**
   * For `http_api`: the header that carries the value mapped to the person or service principal
   * a call runs for, or empty for none. A call for someone without a mapping is refused.
   */
  personContextHeader: string;
  /** For `http_api` with an OAuth choice: the authorization server it names. */
  oauth: ConnectionOAuthForm;
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
  return (
    CONNECTION_OAUTH_CHOICES.find((choice) => choice === value) ??
    CONNECTION_AUTH_CHOICES.find((choice) => choice === value) ??
    "none"
  );
}

/** Whether the scheme is a REST API's OAuth choice, whose `settings.oauth` the form writes. */
export function isOAuthChoice(scheme: ConnectionFormAuthScheme): scheme is ConnectionOAuthChoice {
  return scheme === "oauth" || scheme === "oauth_client";
}

/** A REST API's authorization server before anything is typed. */
export function emptyOAuthForm(): ConnectionOAuthForm {
  return {
    authorizationUrl: "",
    tokenUrl: "",
    revocationUrl: "",
    clientId: "",
    scopes: "",
    params: [],
    tokenAuthMethod: "client_secret_post"
  };
}

/** The authorization server a stored definition names, as the form holds it. */
function oauthFormOf(value: unknown): ConnectionOAuthForm {
  const oauth = recordOf(value);
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return {
    authorizationUrl: textOf(oauth.authorizationUrl),
    tokenUrl: textOf(oauth.tokenUrl),
    revocationUrl: textOf(oauth.revocationUrl),
    clientId: textOf(oauth.clientId),
    scopes: scopes.join(" "),
    params: Object.entries(recordOf(oauth.authorizationParams)).map(([name, param]) => ({
      name,
      value: textOf(param)
    })),
    tokenAuthMethod:
      oauth.tokenAuthMethod === "client_secret_basic" ? "client_secret_basic" : "client_secret_post"
  };
}

/** The scopes as typed, each once, in their order. */
function scopesOf(text: string): string[] {
  return [...new Set(text.split(/\s+/u).filter((scope) => scope !== ""))];
}

/**
 * The `settings.oauth` the form writes for a REST API's OAuth choice. What the form does not
 * show, such as an `issuer` written elsewhere, stays.
 */
function oauthSettingsOf(
  form: ConnectionOAuthForm,
  scheme: ConnectionOAuthChoice,
  stored: unknown
): Record<string, unknown> {
  const { issuer } = recordOf(stored);
  const params = headersOf(form.params);
  const authorizationUrl = form.authorizationUrl.trim();
  const revocationUrl = form.revocationUrl.trim();
  return {
    ...(scheme === "oauth" && authorizationUrl !== "" ? { authorizationUrl } : {}),
    tokenUrl: form.tokenUrl.trim(),
    ...(scheme === "oauth" && revocationUrl !== "" ? { revocationUrl } : {}),
    clientId: form.clientId.trim(),
    scopes: scopesOf(form.scopes),
    ...(scheme === "oauth" && Object.keys(params).length > 0
      ? { authorizationParams: params }
      : {}),
    tokenAuthMethod: form.tokenAuthMethod,
    ...(typeof issuer === "string" ? { issuer } : {})
  };
}

/** Whether the OAuth fields a REST API's choice needs are filled. */
export function oauthFormComplete(form: ConnectionFormState): boolean {
  if (form.connectorType !== "http_api" || !isOAuthChoice(form.authScheme)) return true;
  const { oauth } = form;
  return (
    oauth.tokenUrl.trim() !== "" &&
    oauth.clientId.trim() !== "" &&
    (form.authScheme === "oauth_client" || oauth.authorizationUrl.trim() !== "")
  );
}

/**
 * What a REST API's client secret is bound to: the base address's origin and, with an OAuth
 * choice, the origins of the server's addresses and the client id. The instance drops the
 * secret when one of them changes, so the dialog sends it again then.
 */
export function credentialOriginKey(form: ConnectionFormState): string | undefined {
  const base = addressOrigin(form.url);
  if (form.connectorType !== "http_api" || !isOAuthChoice(form.authScheme)) return base;
  const { oauth } = form;
  return [
    base,
    addressOrigin(oauth.tokenUrl),
    form.authScheme === "oauth" ? addressOrigin(oauth.authorizationUrl) : undefined,
    form.authScheme === "oauth" ? addressOrigin(oauth.revocationUrl) : undefined,
    oauth.clientId.trim()
  ].join(" ");
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
    testPath: textOf(settings.testPath),
    personContextHeader: textOf(settings.personContextHeader),
    oauth: connectorType === "http_api" ? oauthFormOf(settings.oauth) : emptyOAuthForm()
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
    testPath: "",
    personContextHeader: "",
    oauth: emptyOAuthForm()
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
 * Whether a REST API with this scheme holds a secret of its own: a key, or the client secret
 * of its OAuth choice. A change to no authentication deletes it.
 */
export function holdsSecret(authScheme: ConnectionFormAuthScheme): boolean {
  return sendsSecret(authScheme) || authScheme === "oauth_client" || authScheme === "oauth";
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
  const personContextHeader = form.personContextHeader.trim();
  // The authorization server is written only with an OAuth choice; another scheme drops it.
  const oauth = isOAuthChoice(form.authScheme)
    ? { oauth: oauthSettingsOf(form.oauth, form.authScheme, recordOf(config.settings).oauth) }
    : {};
  return {
    ...config,
    settings: {
      baseUrl: form.url.trim(),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(testPath === "" ? {} : { testPath }),
      ...(personContextHeader === "" ? {} : { personContextHeader }),
      ...credentialHeader,
      ...oauth
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
  start: {
    name: string;
    title: string;
    description?: string;
    copyOf?: Record<string, unknown>;
    /** Each person signs in with their own account: the Connection signs in with OAuth. */
    credentialMode?: ConnectionCredentialMode;
  },
  form: ConnectionFormState
): Record<string, unknown> {
  const copied = start.copyOf ?? {};
  const personal = start.credentialMode === "user";
  // What the person typed, an empty field included; without a field, the copied description.
  const description = (start.description ?? textOf(copied.description)).trim();
  return withConnectionForm(
    {
      name: start.name,
      displayName: start.title,
      ...(description === "" ? {} : { description }),
      connectorType: form.connectorType,
      ...(personal ? { credentialMode: "user" } : {}),
      operations: acceptedOperationsOf(copied),
      enabled: true
    },
    personal ? { ...form, authScheme: "oauth" } : form
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

/**
 * The definition with one accepted operation switched on or off, and everything else of it as
 * it was. An operation that is off stays accepted and is callable from no surface.
 */
export function withOperationEnabled(
  config: Record<string, unknown>,
  name: string,
  enabled: boolean
): Record<string, unknown> {
  return {
    ...config,
    operations: acceptedOperationsOf(config).map((operation) =>
      operation.name === name ? { ...operation, enabled } : operation
    )
  };
}

/**
 * The definition with the name people read and the description, trimmed. An empty description
 * is left out. The id stays: references name it, not the name.
 */
export function withConnectionAbout(
  config: Record<string, unknown>,
  about: { title: string; description: string }
): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "description"));
  const description = about.description.trim();
  return {
    ...rest,
    displayName: about.title.trim(),
    ...(description === "" ? {} : { description })
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

/**
 * The header a REST API Connection sends the mapped person context in, or nothing where it sends
 * none. Only then does its page offer the mappings.
 */
export function personContextHeaderOf(config: Record<string, unknown>): string | undefined {
  if (config.connectorType !== "http_api") return undefined;
  const header = textOf(recordOf(config.settings).personContextHeader).trim();
  return header === "" ? undefined : header;
}

/** How many fields of the form differ from what was loaded. */
export function countConnectionFormChanges(
  form: ConnectionFormState,
  baseline: ConnectionFormState
): number {
  const headerCounts = form.authScheme === "header" || baseline.authScheme === "header";
  const oauthCounts =
    form.connectorType === "http_api" &&
    (isOAuthChoice(form.authScheme) || isOAuthChoice(baseline.authScheme));
  const oauth = (state: ConnectionFormState) =>
    JSON.stringify(
      isOAuthChoice(state.authScheme)
        ? oauthSettingsOf(state.oauth, state.authScheme, undefined)
        : undefined
    );
  return (
    Number(oauthCounts && oauth(form) !== oauth(baseline)) +
    Number(form.url.trim() !== baseline.url.trim()) +
    Number(form.authScheme !== baseline.authScheme) +
    Number(headerCounts && form.headerName.trim() !== baseline.headerName.trim()) +
    Number(
      JSON.stringify(headersOf(form.headers)) !== JSON.stringify(headersOf(baseline.headers))
    ) +
    Number(form.testPath.trim() !== baseline.testPath.trim()) +
    Number(form.personContextHeader.trim() !== baseline.personContextHeader.trim())
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
