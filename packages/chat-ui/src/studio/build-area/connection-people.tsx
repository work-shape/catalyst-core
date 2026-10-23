import { useState, type ReactNode } from "react";
import {
  completedOutput,
  type ConnectionPeople,
  type PersonalConnections
} from "@work-shape/catalyst-api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  FormNotice,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  SkeletonList,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import {
  useInvalidatePersonalConnections,
  usePersonalConnectionsQuery
} from "../../shared/api/personal-connections";
import { formatDate, formatDateTime } from "../../shared/locale-format";
import { useSettingsPage } from "../../shared/settings-page-context";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  mayRevoke,
  ownActions,
  ownSignInOf,
  personalViewOf,
  type PersonalView
} from "./connection-people-model";
import {
  SignInBody,
  popupSignInBrowser,
  useConnectionSignIn,
  type SignInBrowser
} from "./connection-sign-in";

// Personal connections (CS-9a-UI): the person's own sign-in on a personal Connection, as You >
// Connections and the Connection's page show it, and the People section where who may change
// the Connection sees who connected and revokes a sign-in. The instance decides every call:
// connecting needs `connection.use`, the People section `connection.write`.

/** A personal sign-in as the instance answers it: the reader's own, or one person's. */
type PersonalSignIn = Pick<
  PersonalConnections["connections"][number] | ConnectionPeople["people"][number],
  "state" | "account" | "connectedAt" | "lastUsedOn"
>;

const VIEWS: Record<PersonalView, { tone: BadgeTone; label: TranslationKey }> = {
  connected: { tone: "success", label: "personalConnections.stateConnectedUnnamed" },
  needs_reconnect: { tone: "warning", label: "personalConnections.stateNeedsReconnect" },
  not_connected: { tone: "neutral", label: "personalConnections.stateNotConnected" }
};

/** The state of a personal sign-in: Connected as the account, Not connected, Sign in again. */
export function PersonalStateBadge({ signIn }: { signIn: PersonalSignIn }) {
  const { t } = useTranslation();
  const view = personalViewOf(signIn);
  return (
    <Badge tone={VIEWS[view].tone} dot data-personal-state={view}>
      {view === "connected" && signIn.account
        ? t("personalConnections.stateConnected", { account: signIn.account })
        : t(VIEWS[view].label)}
    </Badge>
  );
}

/** "since …" and "last used …" of a sign-in, where it has them. */
export function usePersonalSignInFacts(): (signIn: PersonalSignIn) => string | undefined {
  const { locale, t } = useTranslation();
  return (signIn) => {
    if (personalViewOf(signIn) === "not_connected") return undefined;
    const facts = [
      signIn.connectedAt
        ? t("personalConnections.since", { time: formatDateTime(signIn.connectedAt, locale) })
        : undefined,
      signIn.lastUsedOn
        ? t("personalConnections.lastUsed", {
            // A day without a time: read at noon, so no time zone moves it to another day.
            day: formatDate(`${signIn.lastUsedOn}T12:00:00`, locale)
          })
        : undefined
    ].filter((fact) => fact !== undefined);
    return facts.length === 0 ? undefined : facts.join(" · ");
  };
}

/**
 * Connect, sign in again or disconnect the person's own account on one Connection: the buttons,
 * and below them the wait for the provider, a problem, and the one question before Disconnect.
 * One click on Connect opens the provider in a window of its own; its page shows the
 * permissions asked for.
 */
export function useOwnConnectionControls(
  connection: { name: string; title: string; state: PersonalSignIn["state"] },
  browser: SignInBrowser = popupSignInBrowser
): { buttons: ReactNode; below: ReactNode } {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [asking, setAsking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string }>();
  const actions = ownActions(connection);
  const { name } = connection;
  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => client.connections.oauth_start({ params: { name } }),
      readDetail: async () => ownSignInOf(await client.connections.mine(), name)
    },
    {
      personal: true,
      enabled: false,
      browser,
      onConnected: () => {
        invalidate().catch(() => undefined);
      }
    }
  );
  const phase = signIn.state.phase;

  const disconnect = async () => {
    setDisconnecting(true);
    setNotice(undefined);
    try {
      const answer = completedOutput(await client.connections.disconnect({ params: { name } }));
      if (answer.providerRevocation !== "confirmed") {
        setNotice({ tone: "info", text: t("personalConnections.providerKept") });
      }
    } catch {
      setNotice({ tone: "error", text: t("personalConnections.disconnectFailed") });
    } finally {
      setDisconnecting(false);
      setAsking(false);
      await invalidate();
    }
  };

  const buttons =
    phase === "waiting" ? (
      <Button size="sm" variant="outline" data-sign-in-cancel="" onClick={signIn.cancel}>
        {t("connectionSignIn.cancel")}
      </Button>
    ) : (
      <span className="flex flex-wrap items-center gap-2">
        {actions.connect ? (
          <Button
            size="sm"
            variant={actions.connect === "connect" ? "primary" : "outline"}
            loading={signIn.busy}
            data-personal-connect={actions.connect}
            onClick={() => {
              setNotice(undefined);
              signIn.connect();
            }}
          >
            {t(
              actions.connect === "connect"
                ? "personalConnections.connect"
                : "personalConnections.reconnect"
            )}
          </Button>
        ) : null}
        {actions.disconnect ? (
          <Button
            size="sm"
            variant="outline"
            data-personal-disconnect=""
            onClick={() => setAsking(true)}
          >
            {t("personalConnections.disconnect")}
          </Button>
        ) : null}
      </span>
    );

  const below = (
    <>
      {phase === "waiting" || phase === "failed" ? <SignInBody signIn={signIn} /> : null}
      {notice?.tone === "error" ? (
        <FormNotice tone="error" data-personal-notice="">
          {notice.text}
        </FormNotice>
      ) : notice ? (
        <Banner layout="line" data-personal-notice="">
          {notice.text}
        </Banner>
      ) : null}
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t("personalConnections.disconnectTitle", { title: connection.title })}
        confirmLabel={t("personalConnections.disconnect")}
        loading={disconnecting}
        onConfirm={() => {
          disconnect().catch(() => undefined);
        }}
        onClose={() => setAsking(false)}
      >
        {t("personalConnections.disconnectText", { title: connection.title })}
      </ConfirmDialog>
    </>
  );
  return { buttons, below };
}

/**
 * The sign-in section of a personal Connection's page: the viewer's own account, connected here
 * like under You > Connections. A viewer who may not use the Connection is told so.
 */
export function PersonalSignInSection({ name, title }: { name: string; title: string }) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const mine = usePersonalConnectionsQuery({ apiBaseUrl, authScope, client });
  const facts = usePersonalSignInFacts();
  const own = mine.data?.connections.find((connection) => connection.name === name);
  const signIn = own ?? { state: "not_connected" as const };
  const controls = useOwnConnectionControls({ name, title, state: signIn.state });
  if (mine.isPending) return <SkeletonList rows={2} />;
  if (mine.isError) {
    return <InlineError>{t("personalConnections.loadFailed")}</InlineError>;
  }
  const since = facts(signIn);
  return (
    <div className="grid min-w-0 gap-4" data-personal-sign-in="">
      <KeyValueList>
        <KeyValue label={t("connectionSignIn.state")}>
          <PersonalStateBadge signIn={signIn} />
        </KeyValue>
        {since ? <KeyValue label={t("connectionSignIn.connected")}>{since}</KeyValue> : null}
      </KeyValueList>
      {own === undefined ? (
        <p className="text-body text-muted-foreground">{t("personalConnections.mayNotConnect")}</p>
      ) : (
        <>
          {controls.buttons}
          {controls.below}
        </>
      )}
    </div>
  );
}

/**
 * Who connected their own account to a personal Connection, for who may change it: the person,
 * the account the provider named, the state, since when and the last day it was used, and
 * Revoke. Revoking deletes the stored access; the grant at the provider stays.
 */
export function ConnectionPeopleSection({ name, mayWrite }: { name: string; mayWrite: boolean }) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const facts = usePersonalSignInFacts();
  const key = ["connection-people", apiBaseUrl, authScope, name];
  const people = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.connections.people({ params: { name }, signal }),
    retry: false
  });
  const [asking, setAsking] = useState<{ userId: string; name: string }>();
  const [revoking, setRevoking] = useState(false);
  const [failed, setFailed] = useState(false);

  const revoke = async (userId: string) => {
    setRevoking(true);
    setFailed(false);
    try {
      await client.connections.revoke_person({ params: { name, userId } });
    } catch {
      setFailed(true);
    } finally {
      setRevoking(false);
      setAsking(undefined);
      await queryClient.invalidateQueries({ queryKey: key });
    }
  };

  if (people.isPending) return <SkeletonList rows={2} />;
  if (people.isError) {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("personalConnections.peopleFailed")}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            people.refetch().catch(() => undefined);
          }}
        >
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  return (
    <div className="grid min-w-0 gap-3" data-connection-people="">
      {people.data.people.length === 0 ? (
        <EmptyState layout="inline">{t("personalConnections.peopleEmpty")}</EmptyState>
      ) : (
        <List aria-label={t("personalConnections.peopleTitle")}>
          {people.data.people.map((person) => {
            const label = person.displayLabel ?? t("personalConnections.unknownPerson");
            const detail = [
              person.account ?? t("personalConnections.accountUnnamed"),
              facts(person)
            ]
              .filter((part) => part !== undefined)
              .join(" · ");
            return (
              <ListRow
                key={person.userId}
                data-person={person.userId}
                leading={<Avatar kind="person" size="sm" name={label} />}
                title={label}
                description={detail}
                descriptionWraps
                chips={<PersonalStateBadge signIn={person} />}
                actionsVisible
                actions={
                  mayRevoke(person, mayWrite) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      data-person-revoke=""
                      onClick={() => setAsking({ userId: person.userId, name: label })}
                    >
                      {t("personalConnections.revoke")}
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </List>
      )}
      <p className="text-caption text-muted-foreground" data-provider-grant-stays="">
        {t("personalConnections.providerGrantStays")}
      </p>
      {failed ? (
        <FormNotice tone="error">{t("personalConnections.revokeFailed")}</FormNotice>
      ) : null}
      <ConfirmDialog
        open={asking !== undefined}
        tone="danger"
        title={t("personalConnections.revokeTitle", { name: asking?.name ?? "" })}
        confirmLabel={t("personalConnections.revoke")}
        loading={revoking}
        onConfirm={() => {
          if (asking) revoke(asking.userId).catch(() => undefined);
        }}
        onClose={() => setAsking(undefined)}
      >
        {t("personalConnections.revokeText", { name: asking?.name ?? "" })}
      </ConfirmDialog>
    </div>
  );
}
