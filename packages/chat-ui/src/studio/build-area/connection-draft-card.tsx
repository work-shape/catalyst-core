import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Braces, Plug } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { ApiClient, AssetSummary } from "@work-shape/catalyst-api-client";
import { Button, Card, FormNotice, IconTile } from "@work-shape/catalyst-ui";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/routes";
import { apiErrorCode } from "../../shared/workspace-utils";
import { requestBuildCreateDialog } from "./build-create-request";
import { buildRouteOfLocation } from "../../shared/build-route";
import {
  isConnectionProposal,
  openConnectionDraft,
  type ConnectionDraft,
  type ConnectionDraftOpening
} from "./connection-draft";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";
import { ConnectionConnectCard } from "./connection-connect-card";
import { connectCardOfProposal } from "./connection-connect-card-model";

// The card of the agent's draft of the tools of a REST API (CS-5c), in the conversation: what
// the tools are for and their names. Its button opens the Connection's approval list with the
// draft; nothing is saved before the person approves there. Only a reader who may write
// Connections gets the button. The card of the agent's proposal of a new Connection
// (CHAT-CONN-1) names what is connected and where, and its button opens the New connection
// dialog again, filled with it.

/** A Connection the draft's id already names. */
interface ExistingConnection {
  connectorType: string;
  /** Its own name in words. */
  title: string;
}

/** Reads a draft's target for this API and identity; only writers can open its approval. */
export interface ConnectionDraftHost {
  apiBaseUrl: string;
  authScope: string;
  /** The person's own sign-in of the Connect card (CHAT-CONN-2b) runs with it. */
  client: ApiClient;
  /**
   * The viewer started the conversation on screen. Only they see the Connect card a refused
   * call carries: a sign-in is the person's own.
   */
  ownsConversation: boolean;
  /**
   * Sends `text` as the person's message to the conversation on screen, queued behind a run that
   * goes (CHAT-CONN-1): the Connect card's word that the service is connected.
   */
  tell?(text: string, agentName?: string): Promise<void>;
  open?(draft: ConnectionDraft): Promise<ConnectionDraftOpening>;
  /**
   * The Connection of an id as the instance holds it, or nothing where there is none: the card
   * names an existing Connection by its own title, never by the agent's.
   */
  connectionOf(name: string): Promise<ExistingConnection | undefined>;
}

/** A Connection title that ends in the word API, such as "Billing-API" or "Billing API". */
const API_TITLE = /(?:^|[\s-])api$/iu;

const ConnectionDraftHostContext = createContext<ConnectionDraftHost | undefined>(undefined);

/** The workspace's host of the cards of drafts and proposals, where there is one. */
export function useConnectionDraftHost(): ConnectionDraftHost | undefined {
  return useContext(ConnectionDraftHostContext);
}

export function ConnectionDraftHostProvider({
  value,
  children
}: {
  value: ConnectionDraftHost | undefined;
  children: ReactNode;
}) {
  return (
    <ConnectionDraftHostContext.Provider value={value}>
      {children}
    </ConnectionDraftHostContext.Provider>
  );
}

/** Reads the Connection of an id as the instance holds it, or nothing where there is none. */
function connectionReader(client: ApiClient, mayWriteConnections: boolean) {
  return (name: string): Promise<ExistingConnection | undefined> =>
    client.assets.get({ params: { kind: "connection", name }, query: {} }).then(
      ({ config }) => ({
        connectorType: typeof config.connectorType === "string" ? config.connectorType : "",
        title:
          typeof config.displayName === "string" && config.displayName !== ""
            ? config.displayName
            : name
      }),
      (error: unknown) => {
        const code = apiErrorCode(error);
        if (code === "NOT_FOUND" || (!mayWriteConnections && code === "FORBIDDEN")) {
          return undefined;
        }
        throw error;
      }
    );
}

/**
 * Opens a draft or a proposal for a person who may create Connections: the page of its
 * Connection, or the list of Connections with the New connection dialog. `showRoute` goes
 * there with the conversation `from` docked beside the page, where one is named.
 */
export function openConnectionDraftIn(
  draft: ConnectionDraft,
  input: {
    client: ApiClient;
    showRoute(route: WorkspaceRoute): void;
    from?: { conversationId: string; agentName?: string };
  }
): Promise<ConnectionDraftOpening> {
  const connectionOf = connectionReader(input.client, true);
  return openConnectionDraft(input.from ? { ...draft, from: input.from } : draft, {
    connectorTypeOf: (name) => connectionOf(name).then((found) => found?.connectorType),
    showConnection: (name) =>
      input.showRoute(
        buildRouteOfLocation({
          kindPath: CONNECTIONS_BUILD_PATH,
          ...(name === undefined ? {} : { name })
        })
      ),
    requestCreateDialog: () => requestBuildCreateDialog(CONNECTIONS_BUILD_PATH)
  });
}

/**
 * The host of the workspace: reads the Connection of the draft's id and shows its page, or the
 * list of Connections with the New connection dialog. Readers can resolve titles without opening it.
 */
export function connectionDraftHost(input: {
  client: ApiClient;
  apiBaseUrl: string;
  authScope: string;
  mayWriteConnections: boolean;
  /** Goes to a page, with the open conversation docked beside it where there is one. */
  showRoute(route: WorkspaceRoute): void;
  /** The conversation on screen and its agent: what a proposal's dialog tells when connected. */
  from?: { conversationId: string; agentName?: string };
  /** The viewer started the conversation on screen. */
  ownsConversation?: boolean;
  /** Sends the person's message to a conversation, queued behind a run that goes. */
  tellConversation?: (
    to: { conversationId: string; agentName?: string },
    text: string
  ) => Promise<void>;
}): ConnectionDraftHost {
  const connectionOf = connectionReader(input.client, input.mayWriteConnections);
  const { from, tellConversation } = input;
  const host: ConnectionDraftHost = {
    apiBaseUrl: input.apiBaseUrl,
    authScope: input.authScope,
    client: input.client,
    ownsConversation: input.ownsConversation ?? false,
    connectionOf,
    ...(from && tellConversation
      ? {
          // The agent a card names, that of the refused call, before the one on screen.
          tell: (text: string, agentName?: string) =>
            tellConversation(agentName === undefined ? from : { ...from, agentName }, text)
        }
      : {})
  };
  if (input.mayWriteConnections) {
    host.open = (draft) =>
      openConnectionDraftIn(draft, {
        client: input.client,
        showRoute: input.showRoute,
        ...(input.from ? { from: input.from } : {})
      });
  }
  return host;
}

/** The card of one draft in the thread. */
export function ConnectionDraftCard({ draft }: { draft: ConnectionDraft }) {
  const host = useContext(ConnectionDraftHostContext);
  // A catalogue entry or an OAuth Connection: the Connect card, in the state the proposal says.
  const connect = host ? connectCardOfProposal(draft, host.open !== undefined) : undefined;
  if (connect) return <ConnectionConnectCard card={connect} draft={draft} />;
  return <ConnectionDraftTargetCard draft={draft} host={host} />;
}

function ConnectionDraftTargetCard({
  draft,
  host
}: {
  draft: ConnectionDraft;
  host: ConnectionDraftHost | undefined;
}) {
  const { name } = draft.connection;
  const queryClient = useQueryClient();
  const assetsKey = workspaceQueryKeys.assets(host?.apiBaseUrl ?? "", host?.authScope ?? "");
  // Studio's cached list is already scoped to this API and reader. A list title remains
  // useful even when the reader cannot fetch the Connection's full configuration.
  const listed = host
    ? queryClient
        .getQueriesData<InfiniteData<{ items: AssetSummary[] }>>({
          queryKey: [...assetsKey, "list", "connection"]
        })
        .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
        .find((row) => row.name === name)
    : undefined;
  const existing = useQuery({
    queryKey: [...assetsKey, "connection-draft-target", name],
    // A query answers no `undefined`: no accessible Connection of the id is `null`.
    queryFn: async () => (host ? ((await host.connectionOf(name)) ?? null) : null),
    enabled: host !== undefined,
    retry: false
  });
  const title =
    existing.data?.title ??
    listed?.title ??
    (host?.open && existing.isPending ? name : draft.connection.title);
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <ConnectionDraftCardView
        draft={draft}
        title={title}
        {...(host?.open ? { onOpen: host.open } : {})}
      />
    </div>
  );
}

/** The card as it shows a draft, with the button where `onOpen` is given. */
export function ConnectionDraftCardView({
  draft,
  title = draft.connection.title,
  onOpen
}: {
  draft: ConnectionDraft;
  /** The Connection's title: its own for an existing one, the draft's for a new one. */
  title?: string;
  onOpen?: (draft: ConnectionDraft) => Promise<ConnectionDraftOpening>;
}) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [outcome, setOutcome] = useState<ConnectionDraftOpening>();
  const { name, connectorType, baseUrl } = draft.connection;
  const count = draft.operations.length;
  const proposal = isConnectionProposal(draft);
  // What the card is. A draft: tools an agent drafted for an API, not yet connected; a title
  // that names the API already, such as "Billing-API", is not given a second "API".
  const heading = proposal
    ? t("connectionCreate.proposalCardTitle", { title })
    : API_TITLE.test(title.trim())
      ? t("connectionCreate.draftCardTitleApi", { title })
      : t("connectionCreate.draftCardTitle", { title });
  const meta = proposal
    ? connectorType === "mcp"
      ? t("connectionCreate.proposalCardMcp", { address: baseUrl })
      : connectorType === "http_api"
        ? t("connectionCreate.proposalCardRest", { address: baseUrl })
        : connectorType
    : count === 1
      ? t("connectionCreate.draftCardMetaOne")
      : t("connectionCreate.draftCardMeta", { count });

  const open = () => {
    if (!onOpen) return;
    setOpening(true);
    setOutcome(undefined);
    onOpen(draft)
      .then(setOutcome, () => setOutcome("failed"))
      .finally(() => setOpening(false));
  };

  return (
    <Card
      padding="md"
      className="min-w-0 overflow-hidden"
      role="group"
      aria-label={heading}
      data-testid="connection-draft-card"
      data-connection={name}
      {...(proposal ? { "data-connection-proposal": connectorType } : {})}
    >
      <div className="flex min-w-0 items-center gap-3 p-4">
        <IconTile>
          {proposal ? <Plug aria-hidden="true" /> : <Braces aria-hidden="true" />}
        </IconTile>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="break-words text-label text-foreground">{heading}</p>
          <p className="truncate text-caption text-muted-foreground">{meta}</p>
        </div>
      </div>
      {proposal ? null : (
        <ul className="grid min-w-0 gap-1 border-t px-4 py-3 text-body text-foreground">
          {draft.operations.map((operation) => (
            <li
              key={operation.name}
              className="truncate"
              data-connection-draft-tool={operation.name}
            >
              {operation.title}
            </li>
          ))}
        </ul>
      )}
      <div className="grid min-w-0 gap-2 border-t px-4 py-3">
        {onOpen ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              size="sm"
              variant="outline"
              loading={opening}
              data-connection-draft-open=""
              onClick={open}
            >
              {t(proposal ? "connectionCreate.proposalCardOpen" : "connectionCreate.draftCardOpen")}
            </Button>
            <span className="min-w-0 text-caption text-muted-foreground">
              {t(proposal ? "connectionCreate.proposalCardNote" : "connectionCreate.draftCardNote")}
            </span>
          </div>
        ) : (
          <span className="text-caption text-muted-foreground">
            {t(
              proposal ? "connectionCreate.proposalCardReader" : "connectionCreate.draftCardReader"
            )}
          </span>
        )}
        {outcome === "exists" ? (
          <span className="text-caption text-muted-foreground">
            {t("connectionCreate.proposalCardExists", { title })}
          </span>
        ) : null}
        {outcome === "not_rest" ? (
          <FormNotice tone="error">{t("connectionCreate.draftCardNotRest", { name })}</FormNotice>
        ) : outcome === "failed" ? (
          <FormNotice tone="error">{t("connectionCreate.draftCardFailed")}</FormNotice>
        ) : null}
      </div>
    </Card>
  );
}
