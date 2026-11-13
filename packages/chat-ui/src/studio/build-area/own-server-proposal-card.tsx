import { Plug } from "lucide-react";
import { Button, Card, IconTile, ServiceMark } from "@work-shape/catalyst-ui";
import { usePersonalConnectionsQuery } from "../../shared/api/personal-connections";
import { useTranslation } from "../../shared/i18n";
import { useConnectionDraftHost, type ConnectionDraftHost } from "./connection-draft-host";
import { offerText } from "./connection-typed-model";
import { ownServerHostOf, type OwnServerEntry, type OwnServerProposal } from "./own-server-model";

// The card of an agent's proposal of a person's own MCP server (PMCP-CHAT): "Add MCP server",
// the name and the host. Its button opens the add screen of Settings > You > Connections filled
// with the name and the address; nothing is saved before the person presses Connect there. Only
// the person whose message the run answered gets the buttons. A proposal of a catalogue entry
// (PMCP-CAT) shows the service's mark and "Connect <service>", read from the person's own list
// of entries. In a chat others read (PMCP-CHAT-2) it says that the server's tools work only in
// the person's private chats and offers to start one.

export function OwnServerProposalCard({
  proposal,
  toolCallId
}: {
  proposal: OwnServerProposal;
  /** The call that answered it: whose run it is decides who gets the buttons. */
  toolCallId?: string;
}) {
  const host = useConnectionDraftHost();
  // The run's person where the thread knows the run, else the person who started the chat.
  const mine =
    host !== undefined &&
    ((toolCallId === undefined ? undefined : host.ownsCall?.(toolCallId)) ?? host.ownsConversation);
  return mine && proposal.entry !== undefined ? (
    <EntryProposalCard host={host} proposal={proposal} />
  ) : (
    <ProposalCardView proposal={proposal} host={mine ? host : undefined} />
  );
}

/**
 * The card of a proposed catalogue entry, with the entry's mark once the person's list says it.
 * Shown only to the person the proposal is for.
 */
function EntryProposalCard({
  host,
  proposal
}: {
  host: ConnectionDraftHost;
  proposal: OwnServerProposal;
}) {
  const query = usePersonalConnectionsQuery({
    apiBaseUrl: host.apiBaseUrl,
    authScope: host.authScope,
    client: host.client
  });
  const entry = query.data?.ownServers?.entries?.find(
    (candidate) => candidate.id === proposal.entry
  );
  return <ProposalCardView proposal={proposal} host={host} entry={entry} />;
}

/** The card itself; `host` only for the person the proposal is for, who gets its buttons. */
function ProposalCardView({
  proposal,
  host,
  entry
}: {
  proposal: OwnServerProposal;
  host: ConnectionDraftHost | undefined;
  entry?: OwnServerEntry | undefined;
}) {
  const { locale, t } = useTranslation();
  const openOwnServer = host?.openOwnServer;
  // Proposed in a chat others read: the server's tools will not run here.
  const elsewhere = proposal.privateChat === false;
  const startPrivateChat = elsewhere ? host?.startPrivateChat : undefined;
  const entryTitle = entry ? offerText(entry.title, locale) : undefined;
  const label = entryTitle
    ? t("ownServers.proposalService", { title: entryTitle })
    : t("ownServers.proposalLabel");
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <Card
        padding="md"
        className="min-w-0 overflow-hidden"
        role="group"
        aria-label={`${label}: ${proposal.title}`}
        data-own-server-proposal={proposal.entry ?? ""}
      >
        <div className="flex min-w-0 items-center gap-3 p-4">
          {entry && entryTitle ? (
            <ServiceMark
              name={entryTitle}
              size="lg"
              showName={false}
              {...(entry.mark.logo === undefined
                ? entry.mark.color === undefined
                  ? {}
                  : { color: entry.mark.color }
                : { logo: entry.mark.logo })}
            />
          ) : (
            <IconTile>
              <Plug aria-hidden="true" />
            </IconTile>
          )}
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-caption text-muted-foreground">{label}</p>
            <p className="break-words text-label text-foreground">{proposal.title}</p>
            <p className="truncate text-caption text-muted-foreground">
              {ownServerHostOf(proposal.url)}
            </p>
          </div>
        </div>
        <div className="grid min-w-0 gap-2 border-t px-4 py-3">
          {openOwnServer ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-own-server-proposal-open=""
                  onClick={() => openOwnServer(proposal)}
                >
                  {t("ownServers.proposalOpen")}
                </Button>
                {startPrivateChat ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-own-server-proposal-private=""
                    onClick={() => startPrivateChat()}
                  >
                    {t("ownServers.proposalStartPrivate")}
                  </Button>
                ) : null}
                <span className="min-w-0 text-caption text-muted-foreground">
                  {t("ownServers.proposalNote")}
                </span>
              </div>
              {elsewhere ? (
                <span
                  className="min-w-0 text-caption text-muted-foreground"
                  data-own-server-proposal-private-only=""
                >
                  {t("ownServers.proposalPrivateOnly")}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-caption text-muted-foreground">
              {t("ownServers.proposalReader")}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
