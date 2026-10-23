import { useState } from "react";
import { Button, Card, FormNotice, ServiceMark } from "@work-shape/catalyst-ui";
import {
  useInvalidatePersonalConnections,
  usePersonalConnectionsQuery
} from "../../shared/api/personal-connections";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  withOwnSignIn,
  type ConnectCard,
  type ConnectCardState
} from "./connection-connect-card-model";
import type { ConnectionDraft, ConnectionDraftOpening } from "./connection-draft";
import { useConnectionDraftHost, type ConnectionDraftHost } from "./connection-draft-card";
import { ownSignInOf, personalViewOf } from "./connection-people-model";
import {
  SignInBody,
  popupSignInBrowser,
  useConnectionSignIn,
  type ConnectionSignIn,
  type SignInBrowser
} from "./connection-sign-in";

// The Connect card in the conversation (CHAT-CONN-2b): the service's mark, "<Service> verbinden",
// one line on what the agent then does, and one button. Connect signs the person's own account
// in, in a window of its own, and once it is connected sends their word that it is, so the agent
// carries on. It names no account before the person connected and never a token. A refused call
// shows it only to the person whose conversation it is; their own sign-in is theirs alone.

/** The card in the thread, as the workspace's host lets it act. */
export function ConnectionConnectCard({
  card,
  draft,
  refused = false
}: {
  card: ConnectCard;
  /** The proposal the card stands for: "Einrichten" opens the New connection dialog with it. */
  draft?: ConnectionDraft;
  /** The card stands in place of a refused call: only the conversation's owner sees it. */
  refused?: boolean;
}) {
  const host = useConnectionDraftHost();
  if (!host || (refused && !host.ownsConversation)) return null;
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <HostedConnectCard card={card} host={host} {...(draft ? { draft } : {})} />
    </div>
  );
}

function HostedConnectCard({
  card,
  host,
  draft,
  browser = popupSignInBrowser
}: {
  card: ConnectCard;
  host: ConnectionDraftHost;
  draft?: ConnectionDraft;
  browser?: SignInBrowser;
}) {
  const { t } = useTranslation();
  const { name, title } = card;
  const api = { apiBaseUrl: host.apiBaseUrl, authScope: host.authScope, client: host.client };
  const mine = usePersonalConnectionsQuery({ ...api, enabled: card.personal });
  const invalidate = useInvalidatePersonalConnections(api);
  const own = mine.data?.connections.find((connection) => connection.name === name);
  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => host.client.connections.oauth_start({ params: { name } }),
      readDetail: async () => ownSignInOf(await host.client.connections.mine(), name)
    },
    {
      personal: true,
      enabled: false,
      browser,
      onConnected: () => {
        invalidate().catch(() => undefined);
        // The person's word, sent as theirs: the agent carries on with the Connection.
        host.tell?.(t("connectionCreate.connectCardTold", { title })).catch(() => undefined);
      }
    }
  );
  const shown = withOwnSignIn(card, own ? personalViewOf(own) : undefined);
  const { open } = host;
  return (
    <ConnectionConnectCardView
      title={title}
      name={name}
      state={signIn.state.phase === "connected" ? "connected" : shown.state}
      {...(own?.state === "connected" && own.account ? { account: own.account } : {})}
      signIn={signIn}
      {...(draft && open ? { onSetup: () => open(draft) } : {})}
    />
  );
}

const LINES: Record<ConnectCardState, TranslationKey> = {
  connect: "connectionCreate.connectCardConnectText",
  reconnect: "connectionCreate.connectCardReconnectText",
  connected: "connectionCreate.connectCardConnectedText",
  setup: "connectionCreate.connectCardSetupText",
  ask_admin: "connectionCreate.connectCardAskAdmin"
};

/** The card as it shows one state. Without `signIn` or `onSetup` it has no button. */
export function ConnectionConnectCardView({
  title,
  name,
  state,
  account,
  signIn,
  onSetup
}: {
  title: string;
  name: string;
  state: ConnectCardState;
  /** The account, once connected; never before. */
  account?: string;
  signIn?: ConnectionSignIn;
  onSetup?: (() => Promise<ConnectionDraftOpening>) | undefined;
}) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const heading = t(
    state === "reconnect"
      ? "connectionCreate.connectCardReconnectTitle"
      : "connectionCreate.proposalCardTitle",
    { title }
  );
  const phase = signIn?.state.phase;
  const setup = () => {
    if (!onSetup) return;
    setOpening(true);
    setSetupFailed(false);
    onSetup()
      .then((outcome) => setSetupFailed(outcome === "failed" || outcome === "not_rest"))
      .catch(() => setSetupFailed(true))
      .finally(() => setOpening(false));
  };
  const button =
    (state === "connect" || state === "reconnect") && signIn ? (
      phase === "waiting" ? (
        <Button size="sm" variant="outline" data-sign-in-cancel="" onClick={signIn.cancel}>
          {t("connectionSignIn.cancel")}
        </Button>
      ) : (
        <Button
          size="sm"
          loading={signIn.busy}
          data-connect-card-connect={state}
          onClick={signIn.connect}
        >
          {t(state === "connect" ? "personalConnections.connect" : "personalConnections.reconnect")}
        </Button>
      )
    ) : state === "setup" && onSetup ? (
      <Button size="sm" loading={opening} data-connect-card-setup="" onClick={setup}>
        {t("connectionCreate.connectCardSetup")}
      </Button>
    ) : null;
  return (
    <Card
      padding="md"
      className="grid min-w-0 gap-3 p-3"
      role="group"
      aria-label={heading}
      data-connect-card={state}
      data-connection={name}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <ServiceMark name={title} size="lg" showName={false} />
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <p className="text-label text-foreground wrap-anywhere">{heading}</p>
          <p className="text-caption text-muted-foreground" data-connect-card-line="">
            {state === "connected" && account
              ? t("personalConnections.stateConnected", { account })
              : t(LINES[state], { title })}
          </p>
        </div>
        {button}
      </div>
      {signIn && (phase === "waiting" || phase === "failed") ? (
        <SignInBody signIn={signIn} />
      ) : null}
      {setupFailed ? (
        <FormNotice tone="error">{t("connectionCreate.draftCardFailed")}</FormNotice>
      ) : null}
    </Card>
  );
}
