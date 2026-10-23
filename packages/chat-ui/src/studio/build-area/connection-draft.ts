import type {
  CataloguePart,
  ConnectionCredentialMode,
  ConnectionProposalState,
  ConnectionProposalBindingState,
  ConnectorTokenAuthMethod
} from "@work-shape/catalyst-core";
import {
  CONNECTION_AUTH_CHOICES,
  CONNECTION_OAUTH_CHOICES,
  CONNECTION_TOKEN_AUTH_METHODS,
  connectionConfigToForm,
  type ConnectionFormState,
  type ConnectionFormAuthScheme
} from "./connection-form-model";
import type { CatalogueEntryOffer } from "./connection-catalogue-model";
import { useEffect, useState, useSyncExternalStore } from "react";
import { forgetWhenSessionEnds, sessionMark, sessionStillOn } from "../../shared/shell-session";
import { toolAnswer } from "../../chat/conversation/subject-run";
import {
  declaredCandidate,
  recordOf,
  textOf,
  type ApprovalCandidate
} from "./connection-approval-model";

// The agent's draft of the tools of a REST API (CS-5c): the answer of its draft tool, shown as a
// card in the conversation. The card's button hands the draft to the Connection's page, which
// opens the approval list with it, or, where no Connection of its id exists, to the New
// connection dialog, filled with its type, name, address and header names. Nothing is saved
// before the person approves. A draft holds no key: only what is read here reaches the card,
// the page and the dialog, and no value of a header is among it.
//
// A proposal also carries its auth scheme, OAuth settings, credential mode, optional read
// declarations or a catalogue entry link, plus the state needed by the Connect card.

/** The platform tool the agent drafts with. */
export const CONNECTION_DRAFT_TOOL_NAME = "platform.connections.draft_tools";

/** The platform tool the agent proposes a new Connection with (CHAT-CONN-1). */
export const CONNECTION_PROPOSE_TOOL_NAME = "platform.connections.propose";

/** The Connector type of a REST API. */
const HTTP_API = "http_api";

/** A draft as the card and the approval list read it. */
export interface ConnectionDraft {
  /** A catalogue proposal opens Dienste at this part. */
  entry?: { id: string; part: CataloguePart };
  state?: ConnectionProposalState;
  mayWrite?: boolean;
  bindingState?: ConnectionProposalBindingState;
  /** Proposals may carry read declarations too. */
  proposal?: true;
  /** The Connection the tools are for, and what a new one is filled with. */
  connection: {
    authScheme?: ConnectionFormAuthScheme;
    credentialMode?: ConnectionCredentialMode;
    oauth?: {
      authorizationUrl?: string;
      tokenUrl: string;
      revocationUrl?: string;
      clientId: string;
      scopes?: string[];
      tokenAuthMethod?: ConnectorTokenAuthMethod;
    };
    /** `http_api` for a draft of tools; any type for a proposal. */
    connectorType: string;
    name: string;
    title: string;
    /** The server's or the API's address. Empty for a type whose form asks for it. */
    baseUrl: string;
    headerNames: string[];
    /** The path the test reads, when the draft names one. */
    testPath?: string;
    /** The header a proposal sends the key in, by name: the person types the key. */
    keyHeader?: string;
  };
  /** The drafted read operations, as rows of the approval list. */
  operations: ApprovalCandidate[];
  /**
   * The conversation whose agent proposed the Connection, and that agent: once the dialog has
   * connected it, it tells that conversation, as the person.
   */
  from?: { conversationId: string; agentName?: string };
}

/**
 * The draft the draft tool answered, or nothing for an answer that is no draft, such as a
 * refusal or a call still running. Reads the members a draft has and no other.
 */
export function readConnectionDraft(result: unknown): ConnectionDraft | undefined {
  const answer = toolAnswer(result);
  const connection = recordOf(answer?.connection);
  const name = textOf(connection?.name);
  const title = textOf(connection?.title);
  const baseUrl = textOf(connection?.baseUrl);
  const list = answer?.operations;
  if (name === undefined || title === undefined || baseUrl === undefined || !Array.isArray(list)) {
    return undefined;
  }
  const headers = connection?.headerNames;
  const testPath = textOf(connection?.testPath);
  const operations = list.flatMap((entry): ApprovalCandidate[] => {
    const operation = recordOf(entry);
    const operationName = textOf(operation?.name);
    return operation === undefined || operationName === undefined
      ? []
      : [declaredCandidate(declarationOf(operation), operationName)];
  });
  if (operations.length === 0) return undefined;
  return {
    connection: {
      connectorType: HTTP_API,
      name,
      title,
      baseUrl,
      headerNames: namesOf(headers),
      ...(testPath === undefined ? {} : { testPath })
    },
    operations
  };
}

function namesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Only public OAuth settings from an answer enter the dialog model. */
function proposalOAuth(value: unknown): ConnectionDraft["connection"]["oauth"] {
  const oauth = recordOf(value);
  const tokenUrl = textOf(oauth?.tokenUrl);
  const clientId = textOf(oauth?.clientId);
  if (!oauth || tokenUrl === undefined || clientId === undefined) return undefined;
  const authorizationUrl = textOf(oauth.authorizationUrl);
  const revocationUrl = textOf(oauth.revocationUrl);
  const tokenAuthMethod = CONNECTION_TOKEN_AUTH_METHODS.find(
    (method) => method === oauth.tokenAuthMethod
  );
  return {
    tokenUrl,
    clientId,
    ...(authorizationUrl === undefined ? {} : { authorizationUrl }),
    ...(revocationUrl === undefined ? {} : { revocationUrl }),
    ...(Array.isArray(oauth.scopes) ? { scopes: namesOf(oauth.scopes) } : {}),
    ...(tokenAuthMethod === undefined ? {} : { tokenAuthMethod })
  };
}

/** The public fields of a proposal, including its card state and optional read declarations. */
export function readConnectionProposal(result: unknown): ConnectionDraft | undefined {
  const answer = toolAnswer(result);
  const connection = recordOf(answer?.connection);
  const connectorType = textOf(connection?.connectorType);
  const name = textOf(connection?.name);
  const title = textOf(connection?.title);
  if (connectorType === undefined || name === undefined || title === undefined) return undefined;
  const testPath = textOf(connection?.testPath);
  const keyHeader = textOf(connection?.keyHeader);
  const authScheme = [...CONNECTION_AUTH_CHOICES, ...CONNECTION_OAUTH_CHOICES].find(
    (scheme) => scheme === connection?.authScheme
  );
  const mode = connection?.credentialMode;
  const oauth = proposalOAuth(connection?.oauth);
  const entry = recordOf(answer?.entry);
  const operations = Array.isArray(answer?.operations)
    ? answer.operations.flatMap((value) => {
        const operation = recordOf(value);
        const name = textOf(operation?.name);
        return operation && name ? [declaredCandidate(declarationOf(operation), name)] : [];
      })
    : [];
  return {
    ...(entry && typeof entry.id === "string" && (entry.part === "tools" || entry.part === "source")
      ? { entry: { id: entry.id, part: entry.part } }
      : {}),
    ...(answer?.state === "ready" || answer?.state === "needs_setup"
      ? { state: answer.state }
      : {}),
    ...(typeof answer?.mayWrite === "boolean" ? { mayWrite: answer.mayWrite } : {}),
    ...(answer?.bindingState === "connected" ||
    answer?.bindingState === "needs_reconnect" ||
    answer?.bindingState === "not_connected"
      ? { bindingState: answer.bindingState }
      : {}),
    ...(operations.length > 0 ? { proposal: true as const } : {}),
    connection: {
      ...(authScheme === undefined ? {} : { authScheme }),
      ...(mode === "user" || mode === "shared" ? { credentialMode: mode } : {}),
      ...(oauth === undefined ? {} : { oauth }),
      connectorType,
      name,
      title,
      baseUrl: textOf(connection?.url) ?? "",
      headerNames: namesOf(connection?.headerNames),
      ...(testPath === undefined ? {} : { testPath }),
      ...(keyHeader === undefined ? {} : { keyHeader })
    },
    operations
  };
}

/** A proposal opens a new Connection even when it carries read declarations. */
export function isConnectionProposal(draft: ConnectionDraft): boolean {
  return draft.proposal === true || draft.operations.length === 0;
}

/** Maps only the public fields to the existing dialog model. */
export function connectionDraftForm(draft: ConnectionDraft): ConnectionFormState {
  const connection = draft.connection;
  return connectionConfigToForm({
    connectorType: connection.connectorType,
    authScheme: connection.authScheme ?? (connection.keyHeader ? "header" : "none"),
    settings: {
      url: connection.baseUrl,
      baseUrl: connection.baseUrl,
      headerName: connection.keyHeader,
      testPath: connection.testPath,
      headers: Object.fromEntries(connection.headerNames.map((name) => [name, ""])),
      ...(connection.oauth === undefined ? {} : { oauth: connection.oauth })
    }
  });
}

/** The requested part first, so the existing installer opens there. */
export function connectionDraftEntry(
  draft: ConnectionDraft,
  entries: readonly CatalogueEntryOffer[]
): CatalogueEntryOffer | undefined {
  const entry = entries.find((entry) => entry.offered && entry.id === draft.entry?.id);
  if (!entry || !entry.parts.some((part) => part.part === draft.entry?.part)) return undefined;
  return {
    ...entry,
    parts: [...entry.parts].sort(
      (a, b) => Number(b.part === draft.entry?.part) - Number(a.part === draft.entry?.part)
    )
  };
}

/** The members of a declared operation a draft carries. Whatever else an answer holds stays out. */
const DECLARATION_MEMBERS = [
  "name",
  "effect",
  "title",
  "description",
  "method",
  "path",
  "pathParams",
  "query"
];

function declarationOf(operation: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(operation).filter(([key]) => DECLARATION_MEMBERS.includes(key))
  );
}

/** What the card's button found when it opened the draft. */
export type ConnectionDraftOpening =
  /** The page of the Connection or the New connection dialog opens with the draft. */
  | "opened"
  /** A proposal names a Connection that exists: its page opens, and no dialog. */
  | "exists"
  /** A Connection of the draft's id exists and is no REST API. */
  | "not_rest"
  | "failed";

/**
 * A draft the person opened from its card, on its way to the place that shows it: the page of
 * its Connection, or the New connection dialog. A draft carries no address of its own, so it
 * is kept here for the one step there, and taken by the place that shows it.
 */
let requested: { draft: ConnectionDraft; place: "page" | "new" } | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

forgetWhenSessionEnds(() => {
  requested = undefined;
  changed();
});

/**
 * Opens a draft: on the page of its Connection where one of its id exists, as a REST API;
 * else in the New connection dialog. A proposal of a Connection that exists opens its page. `connectorTypeOf` reads the type of the Connection of an
 * id, or nothing where there is none; it throws where the read failed.
 */
export async function openConnectionDraft(
  draft: ConnectionDraft,
  host: {
    connectorTypeOf(name: string): Promise<string | undefined>;
    /** Shows the Connection's page, or the list of Connections for `undefined`. */
    showConnection(name: string | undefined): void;
    /** Asks the list of Connections to open the New connection dialog. */
    requestCreateDialog(): void;
  }
): Promise<ConnectionDraftOpening> {
  const mark = sessionMark();
  if (draft.entry) {
    requested = { draft, place: "new" };
    changed();
    host.requestCreateDialog();
    host.showConnection(undefined);
    return "opened";
  }
  let connectorType: string | undefined;
  try {
    connectorType = await host.connectorTypeOf(draft.connection.name);
  } catch {
    return "failed";
  }
  // The person signed in changed while the read was on its way: the draft is theirs no more.
  if (!sessionStillOn(mark)) return "failed";
  if (connectorType !== undefined && isConnectionProposal(draft)) {
    host.showConnection(draft.connection.name);
    return "exists";
  }
  if (connectorType !== undefined && connectorType !== HTTP_API) return "not_rest";
  requested = { draft, place: connectorType === undefined ? "new" : "page" };
  changed();
  if (connectorType === undefined) {
    host.requestCreateDialog();
    host.showConnection(undefined);
  } else {
    host.showConnection(draft.connection.name);
  }
  return "opened";
}

function requestedNow() {
  return requested;
}

/** The place that shows `draft` took it: a later visit there does not show it again. */
function take(draft: ConnectionDraft): void {
  if (requested?.draft !== draft) return;
  requested = undefined;
  changed();
}

/**
 * A hook: the draft opened for the page of the Connection `name`, held from its arrival until
 * the page closes it. `arrival` counts the drafts that arrived while one was shown, so the list
 * that shows a draft starts again with a newer one instead of keeping the rows it opened with.
 */
export function useOpenedConnectionDraft(name: string): {
  draft: ConnectionDraft | undefined;
  arrival: number;
  close(): void;
} {
  const now = useSyncExternalStore(subscribe, requestedNow, requestedNow);
  const arrived =
    now?.place === "page" && now.draft.connection.name === name ? now.draft : undefined;
  const [shown, setShown] = useState<{ draft: ConnectionDraft; arrival: number }>();
  useEffect(() => {
    if (!arrived) return;
    setShown((current) => ({ draft: arrived, arrival: (current?.arrival ?? 0) + 1 }));
    take(arrived);
  }, [arrived]);
  return {
    draft: shown?.draft,
    arrival: shown?.arrival ?? 0,
    close: () => setShown(undefined)
  };
}

/** A hook: the draft opened for a new Connection, as the New connection dialog starts with it. */
export function useDraftForNewConnection(): ConnectionDraft | undefined {
  const [draft] = useState(() => (requested?.place === "new" ? requested.draft : undefined));
  useEffect(() => {
    if (draft) take(draft);
  }, [draft]);
  return draft;
}
