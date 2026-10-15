import { useQuery } from "@tanstack/react-query";
import { Braces } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { ApiClient } from "@vivd-catalyst/api-client";
import { Button, Card, FormNotice, IconTile } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { WorkspaceRoute } from "../routes";
import { apiErrorCode } from "../workspace-utils";
import { requestBuildCreateDialog } from "./build-create-request";
import { buildRouteOfLocation } from "./build-route";
import {
  openConnectionDraft,
  type ConnectionDraft,
  type ConnectionDraftOpening
} from "./connection-draft";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";

// The card of the agent's draft of the tools of a REST API (CS-5c), in the conversation: what
// the tools are for and their names. Its button opens the Connection's approval list with the
// draft; nothing is saved before the person approves there. Only a reader who may write
// Connections gets the button.

/** A Connection the draft's id already names. */
interface ExistingConnection {
  connectorType: string;
  /** Its own name in words. */
  title: string;
}

/** How the card opens a draft. Absent where the reader may write no Connection. */
export interface ConnectionDraftHost {
  open(draft: ConnectionDraft): Promise<ConnectionDraftOpening>;
  /**
   * The Connection of an id as the instance holds it, or nothing where there is none: the card
   * names an existing Connection by its own title, never by the agent's.
   */
  connectionOf(name: string): Promise<ExistingConnection | undefined>;
}

const ConnectionDraftHostContext = createContext<ConnectionDraftHost | undefined>(undefined);

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

/**
 * The host of the workspace: reads the Connection of the draft's id and shows its page, or the
 * list of Connections with the New connection dialog. Nothing for a reader who may write none.
 */
export function connectionDraftHost(input: {
  client: ApiClient;
  mayWriteConnections: boolean;
  showRoute(route: WorkspaceRoute): void;
}): ConnectionDraftHost | undefined {
  if (!input.mayWriteConnections) return undefined;
  const connectionOf = (name: string): Promise<ExistingConnection | undefined> =>
    input.client.assets.get({ params: { kind: "connection", name }, query: {} }).then(
      ({ config }) => ({
        connectorType: typeof config.connectorType === "string" ? config.connectorType : "",
        title:
          typeof config.displayName === "string" && config.displayName !== ""
            ? config.displayName
            : name
      }),
      (error: unknown) => {
        if (apiErrorCode(error) === "NOT_FOUND") return undefined;
        throw error;
      }
    );
  return {
    connectionOf,
    open: (draft) =>
      openConnectionDraft(draft, {
        connectorTypeOf: (name) => connectionOf(name).then((found) => found?.connectorType),
        showConnection: (name) =>
          input.showRoute(
            buildRouteOfLocation({
              kindPath: CONNECTIONS_BUILD_PATH,
              ...(name === undefined ? {} : { name })
            })
          ),
        requestCreateDialog: () => requestBuildCreateDialog(CONNECTIONS_BUILD_PATH)
      })
  };
}

/** The card of one draft in the thread. */
export function ConnectionDraftCard({ draft }: { draft: ConnectionDraft }) {
  const host = useContext(ConnectionDraftHostContext);
  const { name } = draft.connection;
  const existing = useQuery({
    queryKey: ["connection-draft-target", name],
    // A query answers no `undefined`: no Connection of the id is `null`.
    queryFn: async () => (host ? ((await host.connectionOf(name)) ?? null) : null),
    enabled: host !== undefined
  });
  // The agent's title names only a new Connection: an existing one goes by its own, and the id
  // stands in until the read tells which it is.
  const title = !host
    ? draft.connection.title
    : existing.isSuccess
      ? (existing.data?.title ?? draft.connection.title)
      : name;
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <ConnectionDraftCardView
        draft={draft}
        title={title}
        {...(host ? { onOpen: host.open } : {})}
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
  const { name } = draft.connection;
  const count = draft.operations.length;

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
      aria-label={t("connectionCreate.draftCardTitle", { title })}
      data-testid="connection-draft-card"
      data-connection={name}
    >
      <div className="flex min-w-0 items-center gap-3 p-4">
        <IconTile>
          <Braces aria-hidden="true" />
        </IconTile>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate text-label text-foreground">
            {t("connectionCreate.draftCardTitle", { title })}
          </p>
          <p className="truncate text-caption text-muted-foreground">
            {count === 1
              ? t("connectionCreate.draftCardMetaOne")
              : t("connectionCreate.draftCardMeta", { count })}
          </p>
        </div>
      </div>
      <ul className="grid min-w-0 gap-1 border-t px-4 py-3 text-body text-foreground">
        {draft.operations.map((operation) => (
          <li key={operation.name} className="truncate" data-connection-draft-tool={operation.name}>
            {operation.title}
          </li>
        ))}
      </ul>
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
              {t("connectionCreate.draftCardOpen")}
            </Button>
            <span className="min-w-0 text-caption text-muted-foreground">
              {t("connectionCreate.draftCardNote")}
            </span>
          </div>
        ) : (
          <span className="text-caption text-muted-foreground">
            {t("connectionCreate.draftCardReader")}
          </span>
        )}
        {outcome === "not_rest" ? (
          <FormNotice tone="error">{t("connectionCreate.draftCardNotRest", { name })}</FormNotice>
        ) : outcome === "failed" ? (
          <FormNotice tone="error">{t("connectionCreate.draftCardFailed")}</FormNotice>
        ) : null}
      </div>
    </Card>
  );
}
