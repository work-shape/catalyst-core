import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { Button, Card, Dialog, FormNotice, IconTile } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { toolAnswer } from "../../chat/conversation/subject-run";
import { recordOf, textOf } from "./connection-approval-model";
import { invalidateOfferedAgents } from "../../shared/api/agent-placement-mutations";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { connectionGiveSource, type GiveAgent, type GiveOutcome } from "./connection-give";
import { useGiveToAgent, type ConnectionGiveHost } from "./connection-give-step";

// "Einem Agenten geben" in the conversation (CS-5d): the agent's offer of a Connection's
// approved tools, as a card. Its button opens the steps of the give: the agents the person may
// publish, the confirmation that names the agent and the tools, and what happened. The card
// reads the Connection's tools with the person's own rights; what the agent answered names the
// Connection and, where the person named one, the agent chosen first, and nothing else.

/** The platform tool the agent offers the give with. */
export const CONNECTION_OFFER_TOOL_NAME = "platform.connections.offer_to_agent";

/** The offer as the card reads it from the tool's answer. */
export interface ConnectionOffer {
  connection: string;
  agent?: string;
}

/** The offer the tool answered, or nothing for an answer that is none, such as a refusal. */
export function readConnectionOffer(result: unknown): ConnectionOffer | undefined {
  const answer = recordOf(toolAnswer(result));
  const connection = textOf(answer?.connection);
  if (connection === undefined) return undefined;
  const agent = textOf(answer?.agent);
  return { connection, ...(agent === undefined ? {} : { agent }) };
}

/** What the card is handed by the workspace: the reader, their client and the scope of reads. */
export interface ConnectionGiveCardHost {
  client: ApiClient;
  /** The person signed in: a draft they wrote is their own. */
  viewerId: string;
  apiBaseUrl: string;
  authScope: string;
  /** Opens an agent's page in Studio, where the reader may go there. */
  openAgent?(name: string): void;
}

const ConnectionGiveCardHostContext = createContext<ConnectionGiveCardHost | undefined>(undefined);

export function ConnectionGiveCardHostProvider({
  value,
  children
}: {
  value: ConnectionGiveCardHost | undefined;
  children: ReactNode;
}) {
  return (
    <ConnectionGiveCardHostContext.Provider value={value}>
      {children}
    </ConnectionGiveCardHostContext.Provider>
  );
}

/** The card of one offer in the thread. */
export function ConnectionGiveCard({ offer }: { offer: ConnectionOffer }) {
  const host = useContext(ConnectionGiveCardHostContext);
  const queryClient = useQueryClient();
  const client = host?.client;
  // One source while the client is the same: the steps read again only for another.
  const source = useMemo(() => (client ? connectionGiveSource(client) : undefined), [client]);
  const give: ConnectionGiveHost | undefined =
    host && source
      ? {
          source,
          viewerId: host.viewerId,
          ...(host.openAgent ? { openAgent: host.openAgent } : {}),
          given: () => {
            // The agent's page, its draft and the lists of offered agents read what changed.
            queryClient
              .invalidateQueries({
                queryKey: workspaceQueryKeys.assets(host.apiBaseUrl, host.authScope)
              })
              .catch(() => undefined);
            invalidateOfferedAgents(queryClient, host.apiBaseUrl, host.authScope).catch(
              () => undefined
            );
          }
        }
      : undefined;
  const read = useQuery({
    queryKey: [
      "connection-give-card",
      host?.apiBaseUrl ?? "",
      host?.authScope ?? "",
      offer.connection
    ],
    // A query answers no `undefined`: a Connection without tools for agents is `null`.
    queryFn: async () => (source ? ((await source.connection(offer.connection)) ?? null) : null),
    enabled: source !== undefined,
    retry: false
  });
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <ConnectionGiveCardView
        offer={offer}
        {...(give ? { host: give } : {})}
        read={
          read.isPending
            ? { status: "loading" }
            : read.error
              ? { status: "failed" }
              : { status: "ready", connection: read.data ?? undefined }
        }
      />
    </div>
  );
}

type CardRead =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      connection: { title: string; tools: { toolName: string; title: string }[] } | undefined;
    };

/** The card as it shows an offer, with the give where a host is given. */
export function ConnectionGiveCardView({
  offer,
  host,
  read
}: {
  offer: ConnectionOffer;
  host?: ConnectionGiveHost;
  read: CardRead;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [given, setGiven] = useState<{ agent: GiveAgent; outcome: GiveOutcome }>();
  const connection = read.status === "ready" ? read.connection : undefined;
  const title = connection?.title ?? offer.connection;
  const count = connection?.tools.length ?? 0;
  const give = useGiveToAgent({
    host,
    enabled: open,
    connection: offer.connection,
    connectionTitle: title,
    ...(offer.agent === undefined ? {} : { suggested: offer.agent }),
    onClose: () => setOpen(false),
    onGiven: (agent, outcome) => setGiven({ agent, outcome })
  });

  return (
    <>
      <Card
        padding="md"
        className="min-w-0 overflow-hidden"
        role="group"
        aria-label={t("connectionGive.cardTitle", { connection: title })}
        data-testid="connection-give-card"
        data-connection={offer.connection}
      >
        <div className="flex min-w-0 items-center gap-3 p-4">
          <IconTile>
            <Plug aria-hidden="true" />
          </IconTile>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="truncate text-label text-foreground">
              {t("connectionGive.cardTitle", { connection: title })}
            </p>
            {connection ? (
              <p className="truncate text-caption text-muted-foreground">
                {count === 1
                  ? t("connectionGive.cardMetaOne")
                  : t("connectionGive.cardMeta", { count })}
              </p>
            ) : null}
          </div>
        </div>
        {connection ? (
          <ul className="grid min-w-0 gap-1 border-t px-4 py-3 text-body text-foreground">
            {connection.tools.map((tool) => (
              <li
                key={tool.toolName}
                className="truncate"
                data-connection-give-card-tool={tool.toolName}
              >
                {tool.title}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid min-w-0 gap-2 border-t px-4 py-3">
          {read.status === "failed" ? (
            <FormNotice tone="error">{t("connectionGive.cardFailed")}</FormNotice>
          ) : read.status === "ready" && !connection ? (
            <span className="text-caption text-muted-foreground" data-connection-give-card-none="">
              {t("connectionGive.cardNone")}
            </span>
          ) : given ? (
            <span className="text-caption text-muted-foreground" data-connection-give-card-given="">
              {t("connectionGive.cardGiven", { agent: given.agent.title })}
            </span>
          ) : host && connection ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                size="sm"
                variant="outline"
                data-connection-give=""
                onClick={() => setOpen(true)}
              >
                {t("connectionGive.open")}
              </Button>
              <span className="min-w-0 text-caption text-muted-foreground">
                {t("connectionGive.cardNote")}
              </span>
            </div>
          ) : null}
        </div>
      </Card>
      {open ? (
        <Dialog
          open
          title={give.title}
          onClose={() => {
            if (!give.busy) setOpen(false);
          }}
          footer={give.footer}
        >
          {give.body}
        </Dialog>
      ) : null}
    </>
  );
}
